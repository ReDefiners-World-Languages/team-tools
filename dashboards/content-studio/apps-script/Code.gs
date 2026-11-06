// ReDefiners Content Studio board API (Apps Script web app, runs as the account that deploys it).
// Every action needs a Google ID token from an @STAFF_DOMAIN account (Sign in with Google on the page).
// Nothing private lives in this file: the OAuth client id, the staff domain and the storage sheet id are
// Script Properties (Project Settings > Script properties):
//   GOOGLE_CLIENT_ID  the same "Sign in with Google" client id the page uses
//   STAFF_DOMAIN      redefinerswl.org
//   SHEET_ID          the spreadsheet that holds the "Board backup data" tab
//
// Storage: ONLY the tab "Board backup data" of that spreadsheet, columns A:E = collection | id | data | updated at |
// updated by (row 1 = header). One row per item. A:C and E are written as plain text, D as a real date-time.
// The script never sorts, filters, inserts or deletes rows there, never writes past the tab's existing grid, and
// never touches any other tab. A removed item's row is cleared and reused later.
// Several editors: each save sends only the items that changed; the server applies them one item at a time
// under a script lock. Two people editing DIFFERENT items never overwrite each other. If two people edit the
// SAME item, the later save wins for that item (last write wins). Every save raises a revision number; the page
// notices a newer revision on its next heartbeat and reloads the board when the person is not mid-edit.
//
// Presence: each open board calls "heartbeat" every ~18 s. The server keeps who called in the last 45 s in the
// script cache (not in the sheet) and returns that list.

var SHEET_TAB = 'Board backup data';
var HEADER = ['collection', 'id', 'data', 'updated at', 'updated by'];
var ROW_FORMATS = [['@', '@', '@', 'yyyy-mm-dd hh:mm:ss', '@']];
var KEYED = ['camps', 'themes', 'topics', 'docs', 'classes', 'visits', 'cards', 'mix', 'meta'];
var SINGLES = ['people', 'pillars', 'pillarType', 'texts', 'links'];
var MAX_OPS = 300, MAX_JSON = 45000, PRESENCE_TTL_MS = 45000;

var ACTIONS = {
  start: function (req, who) { return { who: publicWho_(who), board: readBoard_(), rev: rev_() }; },
  board: function () { return { board: readBoard_(), rev: rev_() }; },
  save: save_,
  heartbeat: heartbeat_,
  leave: leave_
};

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
  var nowSec = Math.floor(Date.now() / 1000);
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

// ---------- board storage ----------

function sheet_() {
  var id = prop_('SHEET_ID', '');
  if (!id) throw userError_('not_set_up', 'The board storage is not set up yet (SHEET_ID).');
  var sh = SpreadsheetApp.openById(id).getSheetByName(SHEET_TAB);
  if (!sh) throw userError_('not_set_up', 'The "' + SHEET_TAB + '" tab is missing from the spreadsheet.');
  var cache = CacheService.getScriptCache();
  if (cache.get('layout_ok') !== id) {
    checkLayout_(sh);
    cache.put('layout_ok', id, 600);
  }
  return sh;
}

// Throws unless row 1 is exactly the expected header and the tab has room for data rows.
function checkLayout_(sh) {
  if (sh.getMaxColumns() < HEADER.length || sh.getMaxRows() < 2) throw userError_('not_set_up', 'The "' + SHEET_TAB + '" tab is too small.');
  var head = sh.getRange(1, 1, 1, HEADER.length).getValues()[0].map(function (v) { return String(v).trim().toLowerCase(); });
  var ok = HEADER.every(function (h, i) { return head[i] === h; });
  if (!ok) throw userError_('not_set_up', 'Row 1 of "' + SHEET_TAB + '" must read: ' + HEADER.join(' | ') + '.');
}

// Data rows as [collection, id, data] with their row numbers; blank (cleared) rows are reported separately.
function rows_(sh) {
  var last = sh.getLastRow(), out = { items: [], blanks: [] };
  if (last < 2) return out;
  sh.getRange(2, 1, last - 1, 3).getValues().forEach(function (r, i) {
    if (String(r[0]) === '' && String(r[1]) === '') out.blanks.push(i + 2);
    else out.items.push({ row: i + 2, c: String(r[0]), id: String(r[1]), data: String(r[2]) });
  });
  return out;
}

function readBoard_() {
  var board = {};
  KEYED.forEach(function (c) { board[c] = (c === 'mix' || c === 'meta') ? {} : []; });
  rows_(sheet_()).items.forEach(function (r) {
    var c = r.c, id = r.id, v;
    try { v = JSON.parse(r.data); } catch (e) { return; }
    if (c === 'mix' || c === 'meta') board[c][id] = v;
    else if (KEYED.indexOf(c) >= 0) board[c].push(v);
    else if (c === 'single' && SINGLES.indexOf(id) >= 0) board[id] = v;
  });
  return board;
}

function rev_() { return Number(prop_('BOARD_REV', '0')); }

function save_(req, who) {
  var ops = Array.isArray(req.ops) ? req.ops : [];
  if (!ops.length) return { rev: rev_(), applied: 0 };
  if (ops.length > MAX_OPS) throw userError_('bad_request', 'Too many changes in one save.');
  var clean = ops.map(cleanOp_);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw userError_('busy', 'Someone else is saving. Trying again in a moment.');
  try {
    var sh = sheet_(), data = rows_(sh), index = {}, free = data.blanks.slice();
    data.items.forEach(function (r) { index[r.c + '|' + r.id] = r.row; });
    var next = Math.max(sh.getLastRow(), 1) + 1, maxRows = sh.getMaxRows(), now = new Date();
    var writes = [], clears = [];
    clean.forEach(function (op) {
      var k = op.c + '|' + op.id, row = index[k];
      if (op.del) { if (row) { clears.push(row); delete index[k]; } return; }
      if (!row) {
        row = free.length ? free.shift() : next++;
        if (row > maxRows) throw userError_('full', 'The "' + SHEET_TAB + '" tab is full (' + (maxRows - 1) + ' rows). Ask for more rows to be added to it.');
        index[k] = row;
      }
      writes.push({ row: row, values: [op.c, op.id, op.json, now, who.email] });
    });
    writes.forEach(function (w) {
      var range = sh.getRange(w.row, 1, 1, HEADER.length);
      range.setNumberFormats(ROW_FORMATS);
      range.setValues([w.values]);
    });
    clears.forEach(function (r) { sh.getRange(r, 1, 1, HEADER.length).clearContent(); });
    var rev = rev_() + 1;
    PropertiesService.getScriptProperties().setProperty('BOARD_REV', String(rev));
    return { rev: rev, applied: clean.length };
  } finally {
    lock.releaseLock();
  }
}

function cleanOp_(op) {
  var c = String(op && op.c || ''), id = String(op && op.id != null ? op.id : '');
  var okC = c === 'single' ? SINGLES.indexOf(id) >= 0 : KEYED.indexOf(c) >= 0;
  if (!okC || !id || id.length > 64) throw userError_('bad_request', 'A change could not be read.');
  if (op.del) return { c: c, id: id, del: true };
  var json = JSON.stringify(op.v);
  if (json == null || json.length > MAX_JSON) throw userError_('too_big', 'One item is too large to save.');
  return { c: c, id: id, json: json };
}

// ---------- presence ----------

function heartbeat_(req, who) {
  var me = publicWho_(who), now = Date.now();
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
    var now = Date.now();
    Object.keys(map).forEach(function (k) { if (now - map[k].t > PRESENCE_TTL_MS) delete map[k]; });
    if (locked) { change(map); cache.put('presence', JSON.stringify(map), 120); }
    return Object.keys(map).map(function (k) { return { id: k, name: map[k].name, picture: map[k].picture, view: map[k].view }; });
  } finally {
    if (locked) lock.releaseLock();
  }
}

// ---------- one-time setup, run from the editor ----------

// Checks the Script Properties and that the "Board backup data" tab exists with the right header. Changes nothing.
function setup() {
  ['GOOGLE_CLIENT_ID', 'STAFF_DOMAIN', 'SHEET_ID'].forEach(function (k) {
    if (!prop_(k, '')) throw new Error('Missing Script Property: ' + k);
  });
  CacheService.getScriptCache().remove('layout_ok');
  var sh = sheet_(), data = rows_(sh);
  Logger.log('Ready. "' + SHEET_TAB + '" has ' + data.items.length + ' item rows (room for ' + (sh.getMaxRows() - 1) + '). Revision ' + rev_() + '.');
}

// Loads the starting data from a file named "Seed" (function seedData_) pasted into this project.
// Refuses to run if "Board backup data" already holds any data row, so it cannot overwrite live data.
function importSeed() {
  if (typeof seedData_ !== 'function') throw new Error('Paste the Seed file into this project first.');
  CacheService.getScriptCache().remove('layout_ok');
  var sh = sheet_();
  if (sh.getLastRow() > 1) throw new Error('"' + SHEET_TAB + '" already has data rows. Import stopped so nothing is overwritten.');
  var seed = seedData_(), now = new Date(), rows = [];
  KEYED.forEach(function (c) {
    var v = seed[c];
    if (!v) return;
    if (c === 'mix' || c === 'meta') Object.keys(v).forEach(function (k) { rows.push([c, k, JSON.stringify(v[k]), now, 'seed']); });
    else v.forEach(function (item) { rows.push([c, String(item.id), JSON.stringify(item), now, 'seed']); });
  });
  SINGLES.forEach(function (k) { if (seed[k] != null) rows.push(['single', k, JSON.stringify(seed[k]), now, 'seed']); });
  if (rows.length + 1 > sh.getMaxRows()) throw new Error('The seed has ' + rows.length + ' rows but the tab only has room for ' + (sh.getMaxRows() - 1) + '.');
  rows.forEach(function (r) { if (r[2].length > MAX_JSON) throw new Error('Item ' + r[0] + '/' + r[1] + ' is too large.'); });
  if (rows.length) {
    var range = sh.getRange(2, 1, rows.length, HEADER.length);
    range.setNumberFormats(rows.map(function () { return ROW_FORMATS[0]; }));
    range.setValues(rows);
  }
  PropertiesService.getScriptProperties().setProperty('BOARD_REV', '1');
  Logger.log('Imported ' + rows.length + ' rows into "' + SHEET_TAB + '". You can now delete the Seed file.');
}

// ---------- helpers ----------

function prop_(k, d) { var v = PropertiesService.getScriptProperties().getProperty(k); return v == null || v === '' ? d : v; }
function userError_(code, message) { var e = new Error(message); e.userCode = code; return e; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
