// ReDefiners Content Studio board API (Apps Script web app, runs as the account that deploys it).
// Every action needs a Google ID token from an @STAFF_DOMAIN account (Sign in with Google on the page).
// Nothing private lives in this file. The OAuth client id, the staff domain and the workbook id are Script
// Properties (Project Settings > Script properties):
//   GOOGLE_CLIENT_ID  the same "Sign in with Google" client id the page uses (copy it from the Media Library script)
//   STAFF_DOMAIN      redefinerswl.org
//   SHEET_ID          the "Content Studio Data" workbook (the long id in its address bar)
//
// HOW DATA IS STORED (two layers, one direction)
//  1. MASTER STORE = the tab "Board store" (collection | id | json | updated at | updated by). One row per board
//     item, the whole item as JSON. The board loads from it and every save writes to it first, under one script
//     lock, with a revision counter. The board never reads the typed tables.
//  2. TYPED TABLES (Cards, Card links, Topics ... Settings) are a ONE-WAY mirror of the store (TableSync.gs). After a
//     save the touched items are listed in a dirty list; a one-minute trigger writes only those items to their table
//     rows by id. Hand edits in a table are never read back: the next save of that item overwrites them.
//     The import (Import.gs, editor only) is the single way table data enters the store.
//
// Concurrency: each save sends only the items that changed and the server applies them one by one under the script
// lock, so two people editing DIFFERENT items never overwrite each other (same item: the later save wins). Every save
// raises BOARD_REV; the page notices the new revision on its next heartbeat and reloads when the person is idle.
//
// Presence: each open board calls "heartbeat" about every 18 s. The server keeps who called in the last 45 s in the
// script cache and returns that list. The heartbeat never touches a spreadsheet.
//
// Limits designed for (Apps Script quotas, Workspace column): 6 min per execution, 6 h/day trigger time, 30
// simultaneous executions, 500,000 property operations/day. Sheets 60 reads and 60 writes per minute per user per
// project might also apply to Apps Script calls (Google does not say), so: one read of the store per save, a few
// writes per save, table writes batched once a minute, unchanged rows skipped, board reads cached per revision.

var STORE_TAB = 'Board store';
var HEADER = ['collection', 'id', 'json', 'updated at', 'updated by'];
var KEYED = ['camps', 'themes', 'topics', 'docs', 'classes', 'visits', 'cards', 'mix', 'meta'];
var SINGLES = ['people', 'pillars', 'pillarType', 'texts', 'links', 'personas'];
var MAX_OPS = 300, MAX_JSON = 49000, PRESENCE_TTL_MS = 45000;
var STORE_GROW_AT = 0.9, STORE_MAX_ROWS = 50000;
var PROTO = 3; // bump when the page/server message format changes; an older page is told to reload

var ACTIONS = {
  start: function (req, who) { return { who: publicWho_(who), board: board_(), rev: rev_(), lists: st_lists_() }; },
  board: function () { return { board: board_(), rev: rev_(), lists: st_lists_() }; },
  save: save_,
  heartbeat: heartbeat_,
  leave: leave_
};

function nowMs_() { return Date.now(); }

function doGet() {
  return json_({ ok: true, service: 'ReDefiners Content Studio API' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad_request', message: 'The request could not be read.' });
  }
  try {
    var action = String(req.action || '');
    if (!ACTIONS.hasOwnProperty(action)) throw userError_('bad_request', 'Unknown action.');
    var who = verifyStaff_(req.idToken);
    if (action !== 'leave' && Number(req.proto) !== PROTO) throw userError_('outdated', 'This page is out of date. Reload it to get the latest version of the board.');
    return json_({ ok: true, data: ACTIONS[action](req, who) });
  } catch (err) {
    if (err.userCode) return json_({ ok: false, error: err.userCode, message: err.message });
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, error: 'server_error', message: 'Something went wrong on our side. Try again in a minute.' });
  }
}

// ---------- sign-in check (same as the Media Library) ----------

function verifyStaff_(idToken) {
  var domain = prop_('STAFF_DOMAIN', 'redefinerswl.org');
  if (!idToken) throw userError_('sign_in_required', 'Sign in with your @' + domain + ' Google account.');
  var cache = CacheService.getScriptCache();
  var key = 'tok:' + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw userError_('sign_in_required', 'Your sign-in expired. Sign in again.');
  var t = JSON.parse(res.getContentText());
  var nowSec = Math.floor(nowMs_() / 1000);
  var ok = t.aud === prop_('GOOGLE_CLIENT_ID', '') &&
    (t.iss === 'accounts.google.com' || t.iss === 'https://accounts.google.com') &&
    String(t.email_verified) === 'true' && t.hd === domain && Number(t.exp) > nowSec;
  if (!ok) throw userError_('not_staff', 'The Content Studio board is for @' + domain + ' Google accounts only.');
  var who = { email: String(t.email).toLowerCase(), name: t.name || String(t.email).split('@')[0], picture: t.picture || '' };
  cache.put(key, JSON.stringify(who), Math.max(60, Math.min(3600, Number(t.exp) - nowSec)));
  return who;
}

function publicWho_(who) { return { id: personId_(who.email), name: who.name, picture: who.picture }; }
function personId_(email) {
  return 'p' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, email)).slice(0, 12);
}

// ---------- workbook access ----------

var ss_ = null;
function ss_open_() {
  if (ss_) return ss_;
  var id = prop_('SHEET_ID', '');
  if (!id) throw userError_('not_set_up', 'The board storage is not set up yet (SHEET_ID).');
  ss_ = SpreadsheetApp.openById(id);
  return ss_;
}

function store_() {
  var sh = ss_open_().getSheetByName(STORE_TAB);
  if (!sh) throw userError_('not_set_up', 'The "' + STORE_TAB + '" tab is missing from the workbook.');
  if (sh.getMaxColumns() < HEADER.length || sh.getMaxRows() < 2) throw userError_('not_set_up', 'The "' + STORE_TAB + '" tab is too small.');
  var head = sh.getRange(1, 1, 1, HEADER.length).getValues()[0].map(function (v) { return String(v).trim().toLowerCase(); });
  if (!HEADER.every(function (h, i) { return head[i] === h; })) throw userError_('not_set_up', 'Row 1 of "' + STORE_TAB + '" must read: ' + HEADER.join(' | ') + '.');
  return sh;
}

// ---------- master store: read ----------

// One read of A:E for every used row. Blank (cleared) rows inside the used area are listed in `free`.
function st_load_(sh) {
  var last = Math.max(sh.getLastRow(), 1), out = { sh: sh, items: [], byKey: {}, free: [], last: 1, maxRows: sh.getMaxRows() };
  if (last < 2) return out;
  sh.getRange(2, 1, last - 1, 5).getDisplayValues().forEach(function (r, i) {
    var row = i + 2;
    if (String(r[0]) === '' && String(r[1]) === '') { out.free.push(row); return; }
    var it = { row: row, c: String(r[0]), id: String(r[1]), json: String(r[2]), at: String(r[3]), by: String(r[4]) };
    out.items.push(it);
    out.byKey[it.c + '|' + it.id] = it;
    out.last = row;
  });
  out.free = out.free.filter(function (r) { return r < out.last; });
  return out;
}

function st_parse_(it) {
  if (it.parsed === undefined) { try { it.parsed = JSON.parse(it.json); } catch (e) { it.parsed = null; } }
  return it.parsed;
}

function readBoardFresh_() {
  var board = {};
  KEYED.forEach(function (c) { board[c] = (c === 'mix' || c === 'meta') ? {} : []; });
  st_load_(store_()).items.forEach(function (r) {
    var c = r.c, v = st_parse_(r);
    if (v == null) return;
    if (c === 'mix' || c === 'meta') board[c][r.id] = v;
    else if (KEYED.indexOf(c) >= 0) board[c].push(v);
    else if (c === 'single' && SINGLES.indexOf(r.id) >= 0) board[r.id] = v;
  });
  return board;
}

// The board for the current revision, cached (gzip + base64, chunks under the 100 KB cache value limit) so that several
// boards reloading after one save cost one sheet read, not one each.
function board_() {
  var rev = rev_(), key = 'board:' + rev, cached = cacheGetBig_(key);
  if (cached) return cached;
  var b = readBoardFresh_();
  if (rev_() === rev) cachePutBig_(key, b, 600);
  return b;
}

function cachePutBig_(key, obj, ttl) {
  try {
    var b64 = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(JSON.stringify(obj), 'application/json')).getBytes());
    var size = 90000, n = Math.ceil(b64.length / size), all = {};
    if (n > 10) return; // too big for the cache: skip it
    for (var i = 0; i < n; i++) all[key + '#' + i] = b64.substr(i * size, size);
    all[key + '#n'] = String(n);
    CacheService.getScriptCache().putAll(all, ttl);
  } catch (e) { /* the cache is an optimisation only */ }
}
function cacheGetBig_(key) {
  try {
    var cache = CacheService.getScriptCache(), n = Number(cache.get(key + '#n') || 0);
    if (!n) return null;
    var keys = [], i;
    for (i = 0; i < n; i++) keys.push(key + '#' + i);
    var got = cache.getAll(keys), b64 = '';
    for (i = 0; i < n; i++) { if (got[keys[i]] == null) return null; b64 += got[keys[i]]; }
    var bytes = Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(b64), 'application/x-gzip')).getBytes();
    return JSON.parse(Utilities.newBlob(bytes).getDataAsString());
  } catch (e) { return null; }
}

function rev_() {
  var c = CacheService.getScriptCache().get('rev');
  if (c != null) return Number(c);
  var v = Number(prop_('BOARD_REV', '0'));
  CacheService.getScriptCache().put('rev', String(v), 21600);
  return v;
}
function setRev_(v) {
  PropertiesService.getScriptProperties().setProperty('BOARD_REV', String(v));
  CacheService.getScriptCache().put('rev', String(v), 21600);
}

// Run from the editor after an import or any other change made outside the board.
function bumpRevision() { setRev_(Number(prop_('BOARD_REV', '0')) + 1); Logger.log('Revision is now ' + prop_('BOARD_REV', '0') + '. Open boards reload when idle.'); }

// ---------- master store: save ----------

function save_(req, who) {
  var ops = Array.isArray(req.ops) ? req.ops : [];
  if (!ops.length) return { rev: rev_(), applied: 0, rejected: [] };
  if (ops.length > MAX_OPS) throw userError_('bad_request', 'Too many changes in one save.');
  var clean = ops.map(cleanOp_);
  return withLock_(15000, function () { return storeApply_(clean, who.email, {}); });
}

function withLock_(ms, fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(ms)) throw userError_('busy', 'Someone else is saving. Trying again in a moment.');
  try { return fn(); } finally { lock.releaseLock(); }
}

function cleanOp_(op) {
  var c = String(op && op.c || ''), id = String(op && op.id != null ? op.id : '');
  var okC = c === 'single' ? SINGLES.indexOf(id) >= 0 : KEYED.indexOf(c) >= 0;
  if (!okC || !id || id.length > 64) throw userError_('bad_request', 'A change could not be read.');
  if (c === 'classes') throw userError_('bad_request', 'Classes are filled from Salesforce and cannot be changed on the board.');
  if (op.del) return { c: c, id: id, del: true };
  return { c: c, id: id, v: op.v };
}

// Applies ops to the store (call inside the script lock). Each op is checked on its own: a bad value rejects that item
// (reported in `rejected`) and the others are still saved. opts.allowClasses lets the Salesforce sync write classes.
function storeApply_(ops, email, opts) {
  opts = opts || {};
  var sh = store_(), data = st_load_(sh), lists = st_lists_(), now = nowMs_();
  var X = st_context_(data, lists, ops);
  var nowSerial = tb_dtSerial_(tb_nowText_(now));
  var free = data.free.slice(), next = data.last + 1, writes = [], clears = [], rejected = [], dirty = [];

  ops.forEach(function (op) {
    var k = op.c + '|' + op.id, it = data.byKey[k];
    try {
      if (op.c === 'classes' && !opts.allowClasses) throw userError_('bad_request', 'Classes are filled from Salesforce.');
      if (op.del) {
        if (it) { clears.push(it.row); delete data.byKey[k]; free.push(it.row); dirty.push(k); }
        return;
      }
      var json = JSON.stringify(op.v);
      if (json == null) throw userError_('bad_request', 'A change could not be read.');
      var old = it ? st_parse_(it) : null;
      st_validate_(op.c, op.id, op.v, old, X);
      if (json.length > MAX_JSON) throw userError_('too_big', st_label_(op.c, op.id, op.v) + ' is too large to save (' + json.length + ' characters; the limit is ' + MAX_JSON + '). Shorten its longest text.');
      if (it && it.json === json) return; // nothing changed: keep the row and its stamp
      writes.push({ row: it ? it.row : null, c: op.c, id: op.id, json: json });
      dirty.push(k);
    } catch (err) {
      if (!err.userCode) throw err;
      rejected.push({ c: op.c, id: op.id, error: err.userCode, message: err.message });
    }
  });

  // rows for new items: reuse cleared rows first, then append; grow the tab near capacity
  var need = writes.filter(function (w) { return w.row == null; }).length;
  if (need) {
    var holes = free.slice().sort(function (a, b) { return a - b; }), lastAppended = 0;
    writes.forEach(function (w) {
      if (w.row != null) return;
      if (holes.length) w.row = holes.shift(); else { w.row = next++; lastAppended = w.row; }
    });
    var usedAfter = data.items.length + need - clears.length, cap = data.maxRows - 1;
    if (lastAppended > data.maxRows || usedAfter > STORE_GROW_AT * cap) {
      var newCap = Math.min(STORE_MAX_ROWS - 1, Math.max(Math.ceil(cap * 1.5), lastAppended - 1));
      if (newCap > cap) { sh.insertRowsAfter(sh.getMaxRows(), newCap - cap); data.maxRows = sh.getMaxRows(); }
      if (lastAppended > data.maxRows) throw userError_('full', 'The "' + STORE_TAB + '" tab is full (' + (data.maxRows - 1) + ' rows; the script adds rows itself up to ' + (STORE_MAX_ROWS - 1) + '). Ask for it to be cleaned up.');
    }
  }

  var rev = rev_(), wrote = false;
  try {
    if (writes.length) { wrote = true; st_writeRows_(sh, writes.map(function (w) { return { row: w.row, values: [w.c, w.id, w.json, nowSerial, email] }; })); }
    clears.sort(function (a, b) { return a - b; });
    clears.forEach(function (r) { wrote = true; sh.getRange(r, 1, 1, HEADER.length).clearContent(); });
  } finally {
    if (wrote) {
      rev += 1;
      setRev_(rev);
      sy_markDirty_(dirty);
    }
  }
  return { rev: rev, applied: writes.length + clears.length, rejected: rejected };
}

// Writes whole rows (A:E) as runs of consecutive rows. Text format is forced first (the id column holds month keys such
// as 2026-11 and card numbers, which Sheets would otherwise turn into dates and numbers).
function st_writeRows_(sh, rows) {
  rows.sort(function (a, b) { return a.row - b.row; });
  var i = 0;
  while (i < rows.length) {
    var j = i;
    while (j + 1 < rows.length && rows[j + 1].row === rows[j].row + 1) j++;
    var run = rows.slice(i, j + 1), range = sh.getRange(run[0].row, 1, run.length, HEADER.length);
    range.setNumberFormats(run.map(function () { return ['@', '@', '@', 'yyyy-mm-dd hh:mm:ss', '@']; }));
    range.setValues(run.map(function (r) { return r.values; }));
    i = j + 1;
  }
}

function st_label_(c, id, v) {
  if (c === 'cards') return 'Card "' + String(v && v.title || id).slice(0, 60) + '"';
  var names = { camps: 'Campaign', themes: 'Theme', topics: 'Topic', docs: 'Document', visits: 'Visit', mix: 'Content mix of', meta: 'Month settings of', classes: 'Class' };
  return (names[c] || 'Item') + ' ' + id;
}

// ---------- Lists (dropdown values) and validation ----------

function st_lists_() {
  var cache = CacheService.getScriptCache(), hit = cache.get('lists');
  if (hit) return JSON.parse(hit);
  var sh = ss_open_().getSheetByName('Lists');
  if (!sh) throw userError_('not_set_up', 'The "Lists" tab is missing from the workbook.');
  var lists = tb_parseLists_(sh.getRange(1, 1, Math.min(sh.getMaxRows(), 80), 16).getDisplayValues());
  cache.put('lists', JSON.stringify(lists), 300);
  return lists;
}

// The names the board may use, taken from the STORE (the typed tables lag by up to a minute), plus this save's own changes.
function st_context_(data, lists, ops) {
  var dyn = { campaign: [], owner: ['Unassigned'], persona: [], pillar: [], themeId: [], visit: [] };
  var single = function (id) { var it = data.byKey['single|' + id]; var v = it && st_parse_(it); return Array.isArray(v) ? v : []; };
  data.items.forEach(function (it) {
    if (it.c === 'camps') { var c = st_parse_(it); if (c && c.n) dyn.campaign.push(String(c.n)); }
    else if (it.c === 'themes') dyn.themeId.push(it.id);
    else if (it.c === 'visits') dyn.visit.push(it.id);
  });
  dyn.owner = dyn.owner.concat(single('people').map(String));
  dyn.persona = single('personas').map(function (p) { return String(p && p[0]); });
  dyn.pillar = single('pillars').map(String);
  ops.forEach(function (op) {
    var it = data.byKey[op.c + '|' + op.id], old = it ? st_parse_(it) : null;
    var drop = function (list, v) { var i = list.indexOf(v); if (i >= 0) list.splice(i, 1); };
    if (op.c === 'camps') { if (old && old.n) drop(dyn.campaign, String(old.n)); if (!op.del && op.v && op.v.n) dyn.campaign.push(String(op.v.n)); }
    else if (op.c === 'themes') { drop(dyn.themeId, op.id); if (!op.del) dyn.themeId.push(op.id); }
    else if (op.c === 'visits') { drop(dyn.visit, op.id); if (!op.del) dyn.visit.push(op.id); }
    else if (op.c === 'single' && !op.del && Array.isArray(op.v)) {
      if (op.id === 'people') dyn.owner = ['Unassigned'].concat(op.v.map(String));
      else if (op.id === 'personas') dyn.persona = op.v.map(function (p) { return String(p && p[0]); });
      else if (op.id === 'pillars') dyn.pillar = op.v.map(String);
    }
  });
  return { lists: lists, dyn: dyn };
}

var DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^\d{1,2}:\d{2}$/, MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// Throws a bad_value error when a value is not allowed. A value that is unchanged from what is already stored is not
// checked again, so a value removed from a list later never blocks unrelated edits of the same item.
function st_validate_(c, id, v, old, X) {
  var L = X.lists, D = X.dyn;
  var lab = st_label_(c, id, v);
  var bad = function (msg) { throw userError_('bad_value', lab + ': ' + msg); };
  var same = function (field, val) { return old != null && old[field] !== undefined && JSON.stringify(old[field]) === JSON.stringify(val); };
  var one = function (what, listName, val, list, field) {
    if (val == null || val === '' || same(field, val)) return;
    if (list.indexOf(String(val)) < 0) bad(what + ' "' + val + '" is not in the ' + listName + ' list. Pick one of the listed values or ask for it to be added.');
  };
  var many = function (what, listName, arr, list, field) {
    if (arr == null) return;
    if (!Array.isArray(arr)) bad(what + ' must be a list.');
    arr.forEach(function (x) {
      if (String(x).indexOf(',') >= 0) bad(what + ': "' + x + '" contains a comma. Values in one table cell are kept apart by commas, so a value cannot contain one. Remove the comma.');
    });
    if (same(field, arr)) return;
    arr.forEach(function (x) { if (list.indexOf(String(x)) < 0) bad(what + ' "' + x + '" is not in the ' + listName + ' list. Pick one of the listed values or ask for it to be added.'); });
  };
  var noComma = function (what, val) { if (String(val == null ? '' : val).indexOf(',') >= 0) bad(what + ' "' + val + '" contains a comma. Names are kept apart by commas in the tables, so a name cannot contain one.'); };
  var dateOk = function (what, val) { if (val !== '' && val != null && !(DATE_RE.test(val) && !isNaN(Date.parse(val + 'T12:00:00Z')))) bad(what + ' "' + val + '" is not a date (yyyy-mm-dd).'); };
  var timeOk = function (what, val) { if (val !== '' && val != null && !(TIME_RE.test(val) && +val.split(':')[0] < 24 && +val.split(':')[1] < 60)) bad(what + ' "' + val + '" is not a time (hh:mm, 24 hour).'); };
  var textGuard = function (obj) {
    Object.keys(obj || {}).forEach(function (f) { if (typeof obj[f] === 'string' && obj[f].length > MAX_JSON) throw userError_('too_big', lab + ': "' + f + '" is ' + obj[f].length + ' characters; the limit is ' + MAX_JSON + '.'); });
  };
  if (v == null || typeof v !== 'object') bad('the item could not be read.');

  if (c === 'cards') {
    if (!/^\d+$/.test(id) || +id <= 0) bad('a card id must be a whole number.');
    textGuard(v);
    one('Campaign', 'Campaigns', v.camp, D.campaign, 'camp');
    one('Stage', 'Stage', v.status, L.stagekey, 'status');
    one('Owner', 'People', v.owner, D.owner, 'owner');
    many('Formats', 'Format', v.formats, L.format, 'formats');
    many('Platforms', 'Platform', v.plats, L.platform, 'plats');
    many('Audience', 'Personas', v.pers, D.persona, 'pers');
    one('Visit', 'Visits', v.visit, D.visit, 'visit');
    one('Mix category', 'Mix Category', v.mix, L.mixcode, 'mix');
    one('Content theme', 'Themes', v.theme, D.themeId, 'theme');
    one('Pillar', 'Pillars', v.pillar, D.pillar, 'pillar');
    dateOk('Post date', v.post); timeOk('Post time', v.time);
    (v.links || []).forEach(function (l, i) {
      var oldKind = old && old.links && old.links[i] ? old.links[i].k : undefined;
      if (l.k != null && l.k !== '' && l.k !== oldKind && L.lkind.indexOf(String(l.k)) < 0) bad('Link kind "' + l.k + '" is not in the Link Kind list.');
    });
  } else if (c === 'topics') {
    if (!/^\d+$/.test(id)) bad('a topic id must be a whole number.');
    if (v.m !== '' && v.m != null && !MONTH_RE.test(v.m)) bad('Month "' + v.m + '" must look like 2026-11.');
    dateOk('Date', v.date);
    one('Kind', 'Topic Kind', v.kind, L.tkind, 'kind');
    textGuard(v);
  } else if (c === 'docs') {
    one('Level label', 'Document Level', v.ln, L.dlevel, 'ln');
    one('Status', 'Document Status', v.s, L.dstatus, 's');
    if (v.l !== '' && v.l != null && L.lcode.indexOf(String(v.l)) < 0) bad('Level "' + v.l + '" is not in the Level code list.');
    if (v.ln && v.l && L.lcode[L.dlevel.indexOf(v.ln)] !== String(v.l)) bad('Level label "' + v.ln + '" does not belong to level ' + v.l + '.');
    textGuard(v);
  } else if (c === 'themes') {
    many('Home pillars', 'Pillars', v.pil, D.pillar, 'pil');
    one('Per', 'Period', v.fp, L.period, 'fp');
    if (v.fn != null && v.fn !== '' && !(Number.isInteger(+v.fn) && +v.fn >= 1 && +v.fn <= 10)) bad('Count must be a whole number from 1 to 10.');
    textGuard(v);
  } else if (c === 'camps') {
    noComma('Campaign name', v.n);
    if (v.c && !/^#[0-9A-Fa-f]{6}$/.test(v.c)) bad('Colour "' + v.c + '" must look like #FFC100.');
    textGuard(v);
  } else if (c === 'mix') {
    if (!MONTH_RE.test(id)) bad('the month key must look like 2026-11.');
    many('Locked', 'Mix code', v.lock, L.mixcode, 'lock');
    ['e', 'c', 'p', 'o'].forEach(function (k) { if (v[k] != null && !(Number.isInteger(+v[k]) && +v[k] >= 0 && +v[k] <= 100)) bad('the share "' + k + '" must be a whole number from 0 to 100.'); });
    textGuard(v);
  } else if (c === 'meta') {
    if (!MONTH_RE.test(id)) bad('the month key must look like 2026-11.');
    many('Campaign list', 'Campaigns', v.camps, D.campaign, 'camps');
    textGuard(v);
  } else if (c === 'visits') {
    one('Who', 'People', v.who, D.owner, 'who');
    dateOk('Date', v.date);
    (v.cls || []).forEach(function (x) { if (!Number.isInteger(+x)) bad('Class IDs must be whole numbers.'); });
    (v.shots || []).forEach(function (s) { if (s && s.k != null && s.k !== '' && !Number.isInteger(+s.k)) bad('A shot has a class id that is not a whole number.'); });
    textGuard(v);
  } else if (c === 'classes') {
    if (v.day != null && v.day !== '' && !(Number.isInteger(+v.day) && +v.day >= 1 && +v.day <= 7)) bad('Day must be 1 (Monday) to 7 (Sunday).');
    dateOk('End date', v.end); timeOk('Time', v.time);
  } else if (c === 'single') {
    var isArr = function () { if (!Array.isArray(v)) bad('the value must be a list.'); };
    if (id === 'people') { isArr(); v.forEach(function (p) { noComma('Person', p); }); }
    else if (id === 'pillars') { isArr(); v.forEach(function (p) { noComma('Pillar name', p); }); }
    else if (id === 'personas') { isArr(); v.forEach(function (p) { if (!Array.isArray(p)) bad('a persona must be [name, role].'); noComma('Persona name', p[0]); }); }
    else if (id === 'pillarType') {
      Object.keys(v).forEach(function (p) { noComma('Pillar name', p); if (v[p] !== '' && L.ptype.indexOf(String(v[p])) < 0 && !(old && old[p] === v[p])) bad('Type "' + v[p] + '" of pillar "' + p + '" is not in the Pillar Type list (social or blog).'); });
    } else textGuard(v);
  }
}

// ---------- presence (cache only, never a spreadsheet) ----------

function heartbeat_(req, who) {
  var me = publicWho_(who), now = nowMs_();
  var list = updatePresence_(function (map) {
    map[me.id] = { name: me.name, picture: me.picture, view: String(req.view || '').slice(0, 20), t: now };
  });
  return { people: list.map(function (p) { p.self = p.id === me.id; return p; }), rev: rev_() };
}

function leave_(req, who) {
  var id = personId_(who.email);
  updatePresence_(function (map) { delete map[id]; });
  return { ok: true };
}

function updatePresence_(change) {
  var cache = CacheService.getScriptCache(), lock = LockService.getScriptLock();
  var locked = lock.tryLock(3000);
  try {
    var map = {};
    try { map = JSON.parse(cache.get('presence') || '{}'); } catch (e) { map = {}; }
    var now = nowMs_();
    Object.keys(map).forEach(function (k) { if (now - map[k].t > PRESENCE_TTL_MS) delete map[k]; });
    if (locked) { change(map); cache.put('presence', JSON.stringify(map), 120); }
    return Object.keys(map).map(function (k) { return { id: k, name: map[k].name, picture: map[k].picture, view: map[k].view }; });
  } finally {
    if (locked) lock.releaseLock();
  }
}

// ---------- one-time setup, run from the editor ----------

// Checks the Script Properties, the "Board store" tab, the Lists tab and the header row of all 15 typed tables.
// Changes nothing. Refuses (throws) on any mismatch.
function setup() {
  ['GOOGLE_CLIENT_ID', 'STAFF_DOMAIN', 'SHEET_ID'].forEach(function (k) {
    if (!prop_(k, '')) throw new Error('Missing Script Property: ' + k);
  });
  ss_ = null;
  CacheService.getScriptCache().remove('lists');
  var sh = store_(), data = st_load_(sh), lists = st_lists_();
  var problems = [];
  Object.keys(TB).forEach(function (k) {
    try { var t = tb_readTable_(k, { headerOnly: true }); Logger.log('OK  ' + TB[k].tab + ': header matches; room for ' + t.cap + ' rows (the script grows it to at most ' + TB[k].max + ').'); }
    catch (e) { problems.push(e.message); }
  });
  if (problems.length) throw new Error('Setup stopped. ' + problems.join(' | '));
  Logger.log('Ready. "' + STORE_TAB + '" has ' + data.items.length + ' item rows (room for ' + (sh.getMaxRows() - 1) + '). Revision ' + prop_('BOARD_REV', '0') + '. Lists: ' + Object.keys(lists).length + ' lists found. Table sync switch: SYNC_ENABLED=' + prop_('SYNC_ENABLED', 'not set') + '.');
}

// ---------- helpers ----------

function prop_(k, d) { var v = PropertiesService.getScriptProperties().getProperty(k); return v == null || v === '' ? d : v; }
function userError_(code, message) { var e = new Error(message); e.userCode = code; return e; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
