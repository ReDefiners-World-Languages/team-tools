// ReDefiners Content Studio: ONE-WAY sync from the "Board backup data" tab to the Content Matrix tabs.
//
// Safe by default:
//   SYNC_ENABLED  must be "true" (Script Property) or nothing runs. Missing = sync not configured (page shows nothing).
//   SYNC_DRY_RUN  "true" = read everything, compute everything, write NOTHING; the planned writes go to the execution log
//                 and to the sync status the page shows.
//   The one-minute trigger is installed only by running installSyncTrigger() by hand (removeSyncTrigger() turns it off).
//
// How it runs: a board save records which tabs are affected in the Script Property SYNC_DIRTY and returns at once.
// syncTick() (every minute) exits in milliseconds when nothing is dirty; otherwise it takes the SYNC lease (a separate
// lock, so board saves never wait for the matrix), recomputes the target rows from "Board backup data" (the source of
// truth), skips any tab whose target hash is unchanged since its last successful write, and writes only rows that
// differ, in batched runs. Status (last run, errors, rows touched) is kept in the Script Property SYNC_STATUS and in
// the execution log; there is no log tab.
//
// What the sync may touch: only rows that carry a Board ID in the tab's "Board ID" column, only the columns it owns,
// never banner rows, the header rows above them, the Due Date column (except carrying a row's own Due Date when a
// card moves month), or any tab not listed below. Empty board values never blank a cell. Status cells that already
// say Published or Cancelled are never changed. Deleted or undated cards mark their row Cancelled (rows are kept).
// Themes not in use, deleted topics' months stay; deleted themes and documents have their rows removed.

var SYNC = {
  // Calendar tabs the sync writes, by month. September and October 2026 are hand-managed and NOT synced.
  CAL_TABS: { '2026-11': 'November 2026 Calendar', '2026-12': 'December 2026 Calendar' },
  TOPICS_TAB: 'Monthly Topics',
  MIX_TAB: 'The Content Mix',
  DOCS_TAB: 'Document Map',
  ID_HEADER: 'Board ID',
  MARKER_HEADER: 'From board',
  MARKER: 'From board',
  LEASE_MS: 6 * 60 * 1000,
  // Fictional personas from the board (public, same as the personas page) for the Audience column.
  PERSONAS: {
    'Yolanda Reyes': 'Adult ESOL & Conversation-Course Learner',
    'Carmen Ibarra': 'Parent & Caregiver',
    'Priya Anand': 'Employer & Workforce Training Buyer',
    'Walter Ostrowski': 'Individual Donor',
    'Renata Voss': 'Institutional & Grant Funder',
    'Jamal Coleman': 'Priority Community Neighbor'
  },
  CONTENT_TYPES: ['Blog Pillar Page', 'Blog Article', 'Instagram Post', 'Instagram Carousel', 'Instagram Story', 'Instagram Reel',
    'TikTok', 'YouTube Short', 'YouTube Video', 'Facebook Post', 'Facebook Story', 'LinkedIn Post', 'Email Send', 'Meta Ad', 'Portal Banner'],
  PLAT_ORDER: ['Instagram', 'Facebook', 'LinkedIn', 'TikTok', 'YouTube', 'Email', 'Website', 'Meta Ads'],
  CT_MAP: {
    'Reel': { Instagram: 'Instagram Reel', Facebook: 'Facebook Post', LinkedIn: 'LinkedIn Post', TikTok: 'TikTok', YouTube: 'YouTube Short' },
    'Static post': { Instagram: 'Instagram Post', Facebook: 'Facebook Post', LinkedIn: 'LinkedIn Post' },
    'Carousel': { Instagram: 'Instagram Carousel', Facebook: 'Facebook Post', LinkedIn: 'LinkedIn Post' },
    'Story': { Instagram: 'Instagram Story', Facebook: 'Facebook Story' },
    'Video': { YouTube: 'YouTube Video' },
    'Email': { Email: 'Email Send' },
    'Blog article': { Website: 'Blog Article' },
    'Ad': { 'Meta Ads': 'Meta Ad' }
  },
  STAGE_STATUS: { idea: 'Planned', scripting: 'In Progress', tocapture: 'In Progress', captured: 'In Progress', editing: 'In Progress',
    review: 'Ready for Review', tobesched: 'Ready for Schedule', scheduled: 'Ready for Schedule' },
  PROTECTED_STATUS: ['Published', 'Cancelled'],
  DOC_STATUS: { 'Current/Active': 'Current/Active', 'Draft': 'Draft', 'Needs update': 'Needs Update', 'Needs Update': 'Needs Update',
    'Ended': 'Ended', 'Reserved': 'Planned', 'Planned': 'Planned', 'Retired': 'Discontinued', 'Discontinued': 'Discontinued', 'In progress': 'Draft' },
  LEVEL_LABELS: { '1': '1. Marketing Plan', '2': '2. Campaign Briefs', '3': '3. Content Plan', '4': '4. Channel Playbooks', 'S': 'Supporting' }
};
var SYNC_KEYS = ['cal', 'topics1', 'topics2', 'mix', 'docs'];
// Which tab blocks a changed collection affects.
var DIRTY_MAP = { cards: ['cal'], camps: ['cal'], topics: ['topics2'], meta: ['topics2'], mix: ['topics2', 'mix'],
  themes: ['topics1'], pillars: ['topics1', 'cal'], pillarType: ['topics1'], docs: ['docs'] };

// ---------- entry points ----------

function syncTick() {
  if (prop_('SYNC_ENABLED', '') !== 'true') return;
  var dirty = readDirty_();
  if (!Object.keys(dirty).length) return;
  runSync_({ keys: Object.keys(dirty), snapshot: dirty });
}

function syncNowAction_(req, who) {
  if (prop_('SYNC_ENABLED', '') !== 'true') throw userError_('sync_off', 'Matrix sync is switched off.');
  var dirty = readDirty_();
  runSync_({ keys: SYNC_KEYS.slice(), snapshot: dirty, by: who.email });
  return { sync: syncStatus_() };
}

function installSyncTrigger() {
  removeSyncTrigger();
  ScriptApp.newTrigger('syncTick').timeBased().everyMinutes(1).create();
  Logger.log('Sync trigger installed (every minute). SYNC_ENABLED=' + prop_('SYNC_ENABLED', '(missing)') + ', SYNC_DRY_RUN=' + prop_('SYNC_DRY_RUN', 'false') + '.');
}

function removeSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'syncTick') ScriptApp.deleteTrigger(t); });
}

// Marks every block dirty and runs once now (from the editor). Respects SYNC_ENABLED and SYNC_DRY_RUN.
function syncAllNow() {
  if (prop_('SYNC_ENABLED', '') !== 'true') throw new Error('Set the Script Property SYNC_ENABLED to true first.');
  runSync_({ keys: SYNC_KEYS.slice(), snapshot: readDirty_(), force: true });
  Logger.log(JSON.stringify(syncStatus_()));
}

// ---------- dirty list (Script Property SYNC_DIRTY = {blockKey: counter}) ----------

// Called by save_ while it already holds the script lock.
function markDirty_(ops) {
  var keys = {};
  ops.forEach(function (op) {
    var col = op.c === 'single' ? op.id : op.c;
    (DIRTY_MAP[col] || []).forEach(function (k) { keys[k] = true; });
  });
  if (!Object.keys(keys).length) return;
  var d = readDirty_();
  Object.keys(keys).forEach(function (k) { d[k] = (d[k] || 0) + 1; });
  PropertiesService.getScriptProperties().setProperty('SYNC_DIRTY', JSON.stringify(d));
}

function readDirty_() {
  try { return JSON.parse(prop_('SYNC_DIRTY', '{}')) || {}; } catch (e) { return {}; }
}

// Removes only the keys whose counter did not change while the sync ran (a save during the run keeps it dirty).
function clearDirty_(done, snapshot) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var d = readDirty_();
    done.forEach(function (k) { if (d[k] === snapshot[k] || d[k] == null) delete d[k]; });
    PropertiesService.getScriptProperties().setProperty('SYNC_DIRTY', JSON.stringify(d));
  } finally { lock.releaseLock(); }
}

// ---------- the separate sync lease ----------

function acquireLease_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return false;
  try {
    var p = PropertiesService.getScriptProperties();
    if (Number(p.getProperty('SYNC_LEASE') || 0) > Date.now()) return false;
    p.setProperty('SYNC_LEASE', String(Date.now() + SYNC.LEASE_MS));
    return true;
  } finally { lock.releaseLock(); }
}
function releaseLease_() { PropertiesService.getScriptProperties().setProperty('SYNC_LEASE', '0'); }

// ---------- status ----------

function syncStatus_() {
  var en = prop_('SYNC_ENABLED', '');
  if (!en) return null;
  var st = {};
  try { st = JSON.parse(prop_('SYNC_STATUS', '{}')) || {}; } catch (e) { st = {}; }
  return { enabled: en === 'true', dry: prop_('SYNC_DRY_RUN', '') === 'true', pending: Object.keys(readDirty_()).length > 0,
    lastRun: st.lastRun || null, lastOk: st.lastOk || null, error: st.error || '', failures: st.failures || 0,
    counts: st.counts || null, notes: st.notes || [] };
}

function saveStatus_(st) {
  var s = JSON.stringify(st);
  while (s.length > 8500 && st.notes && st.notes.length) { st.notes.pop(); s = JSON.stringify(st); }
  PropertiesService.getScriptProperties().setProperty('SYNC_STATUS', s);
}

// ---------- the run ----------

function runSync_(opt) {
  if (!acquireLease_()) return false;
  var dry = prop_('SYNC_DRY_RUN', '') === 'true';
  var prev = {};
  try { prev = JSON.parse(prop_('SYNC_STATUS', '{}')) || {}; } catch (e) { prev = {}; }
  var ctx = newCtx_(dry);
  var done = [], errors = [];
  try {
    var state = readBoard_();
    var ss = SpreadsheetApp.openById(prop_('SHEET_ID', ''));
    var order = SYNC_KEYS.filter(function (k) { return opt.keys.indexOf(k) >= 0; });
    order.forEach(function (k) {
      try {
        var target = BUILD_[k](state, ctx);
        var hash = hash_(target);
        if (!opt.force && !dry && prop_('SYNC_HASH_' + k, '') === hash) { ctx.counts.skipped++; done.push(k); return; }
        APPLY_[k](ss, target, ctx);
        if (!dry) PropertiesService.getScriptProperties().setProperty('SYNC_HASH_' + k, hash);
        done.push(k);
      } catch (err) {
        errors.push(k + ': ' + (err && err.message ? err.message : err));
        console.error(err && err.stack ? err.stack : err);
      }
    });
    if (!dry) clearDirty_(done, opt.snapshot || {});
  } catch (err) {
    errors.push(err && err.message ? err.message : String(err));
  } finally {
    var now = new Date().toISOString();
    saveStatus_({ lastRun: now, lastOk: errors.length ? (prev.lastOk || null) : now, error: errors.join(' | ').slice(0, 1500),
      failures: errors.length ? (prev.failures || 0) + 1 : 0, counts: ctx.counts, notes: ctx.notes.slice(0, 40), dry: dry });
    if (dry) Logger.log('DRY RUN, nothing written:\n' + ctx.plan.join('\n'));
    Logger.log('Sync ' + (errors.length ? 'finished with errors: ' + errors.join(' | ') : 'ok') + ' ' + JSON.stringify(ctx.counts));
    releaseLease_();
  }
  return !errors.length;
}

function newCtx_(dry) {
  var ctx = { dry: dry, plan: [], notes: [], calls: 0,
    counts: { created: 0, updated: 0, cancelled: 0, removed: 0, moved: 0, skipped: 0 } };
  ctx.note = function (s) { if (ctx.notes.indexOf(s) < 0) ctx.notes.push(s); };
  // Every Sheets write goes through here: dry run records it instead.
  ctx.write = function (desc, fn) { if (dry) { ctx.plan.push(desc); return; } ctx.calls++; fn(); };
  return ctx;
}

function hash_(o) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(o)));
}

// ---------- pure mapping: board state -> target rows ----------

var BUILD_ = {
  cal: function (state, ctx) {
    var camps = {}; (state.camps || []).forEach(function (c) { camps[c.n] = c; });
    var rows = {}, cancel = {};
    (state.cards || []).forEach(function (c) {
      var bid = 'card:' + c.id, month = c.post ? String(c.post).slice(0, 7) : '';
      if (month && SYNC.CAL_TABS[month]) rows[bid] = { tab: SYNC.CAL_TABS[month], date: c.post, cells: cardCells_(c, camps, ctx) };
      else cancel[bid] = month ? 'month ' + month + ' is not synced' : 'no post date';
    });
    return { rows: rows, cancel: cancel };
  },
  topics1: function (state) {
    return { rows: (state.themes || []).filter(function (t) { return !t.off; }).map(function (t) {
      return { id: String(t.id), cells: [t.n || '', t.cov || '', (t.pil || []).join('; '), freqText_(t)] };
    }) };
  },
  topics2: function (state) {
    var months = {};
    Object.keys(state.meta || {}).forEach(function (k) { months[k] = true; });
    Object.keys(state.mix || {}).forEach(function (k) { months[k] = true; });
    (state.topics || []).forEach(function (t) { if (t.m) months[t.m] = true; });
    return { rows: Object.keys(months).filter(function (k) { return /^\d{4}-\d{2}$/.test(k); }).sort().map(function (k) {
      var meta = (state.meta || {})[k] || {}, mix = (state.mix || {})[k] || {};
      return { id: k, cells: [monthStart_(k), meta.theme || '', topicLines_(state.topics || [], k), mix.camps || ''] };
    }) };
  },
  mix: function (state) {
    return { rows: Object.keys(state.mix || {}).filter(function (k) { return /^\d{4}-\d{2}$/.test(k); }).sort().map(function (k) {
      var m = state.mix[k];
      return { id: k, cells: [monthStart_(k), m.camps || '', pct_(m.e), pct_(m.c), pct_(m.p), pct_(m.o), m.why || ''] };
    }) };
  },
  docs: function (state, ctx) {
    return { rows: (state.docs || []).map(function (d) {
      var st = SYNC.DOC_STATUS[d.s];
      if (d.s && !st) ctx.note('Document Map: status "' + d.s + '" has no matrix value (' + d.id + '), left as is');
      var label = d.ln || (d.s === 'Reserved' && d.l === '2' ? '2. Campaign Briefs (pending)' : SYNC.LEVEL_LABELS[d.l] || '');
      return { id: String(d.id), level: label, name: d.n || '', url: validUrl_(d.u) ? d.u : '', cells: [label, null, d.a || '', st || ''] };
    }) };
  }
};

function cardCells_(c, camps, ctx) {
  var camp = camps[c.camp] || {};
  var types = contentTypes_(c, ctx);
  var caption = c.caption || '';
  if (c.cta) caption = caption ? caption + '\n\n' + c.cta : c.cta;
  if (c.capEs) caption = (caption ? caption + '\n\n' : '') + 'Espanol:\n' + c.capEs;
  var canva = (c.links || []).filter(function (l) { return l.k === 'Canva design' && validUrl_(l.u); })[0];
  return {
    'Owner': c.owner && c.owner !== 'Unassigned' ? c.owner : '',
    'Post Date': dateOnly_(c.post),
    'Best Post Time': timeFraction_(c.time),
    'Status': SYNC.STAGE_STATUS[c.status] || 'Planned',
    'Content': c.goal ? 'Goal: ' + c.goal : '',
    'Audience (Persona)': (c.pers || []).map(function (n) { return SYNC.PERSONAS[n] ? n + ' (' + SYNC.PERSONAS[n] + ')' : n; }).join(', '),
    'Content Type': types.join(', '),
    'Distribution Format': distribution_(c.formats || []),
    'Campaign': c.camp || '',
    'Pillar': String(c.pillar || '').replace(/\s*\(Pillar \d+\)\s*$/, ''),
    'Caption Copy + CTA': caption,
    'Hashtags': c.tags || camp.tags || '',
    'Design Link': canva ? hyperlink_(canva.u, canva.t || 'Canva design') : ''
  };
}

function contentTypes_(c, ctx) {
  var out = [];
  SYNC.PLAT_ORDER.forEach(function (p) {
    if ((c.plats || []).indexOf(p) < 0) return;
    (c.formats || []).forEach(function (f) {
      var v = (SYNC.CT_MAP[f] || {})[p];
      if (!v) { ctx.note('No Content Type for ' + f + ' on ' + p + ' (card:' + c.id + ')'); return; }
      if (SYNC.CONTENT_TYPES.indexOf(v) >= 0 && out.indexOf(v) < 0) out.push(v);
    });
  });
  return out;
}

function distribution_(formats) {
  for (var i = 0; i < formats.length; i++) {
    var f = formats[i];
    if (f === 'Email') return 'Email';
    if (f === 'Blog article') return 'Website/Blog';
    if (f !== 'Ad') return 'Organic Social';
  }
  return '';
}

function freqText_(t) {
  var n = Math.max(1, Math.min(10, Number(t.fn) || 1));
  return t.fp === 'week' ? n + 'x/week' : n + 'x/month minimum';
}

function topicLines_(topics, k) {
  var list = topics.filter(function (t) { return t.m === k; });
  var dated = list.filter(function (t) { return t.date; }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  var undated = list.filter(function (t) { return !t.date; });
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return dated.map(function (t) { var p = t.date.split('-'); return '• ' + t.label + ' (' + MON[+p[1] - 1] + ' ' + (+p[2]) + ')'; })
    .concat(undated.map(function (t) { return '• ' + t.label; })).join('\n');
}

function pct_(v) { return v == null || v === '' ? '' : Math.round(Number(v)) / 100; }
function monthStart_(k) { var p = k.split('-'); return new Date(+p[0], +p[1] - 1, 1); }
function dateOnly_(s) { if (!s) return ''; var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
function timeFraction_(t) { if (!t) return ''; var p = String(t).split(':'); return (Number(p[0]) * 60 + Number(p[1] || 0)) / 1440; }
function validUrl_(u) { return /^https:\/\/[^\s"<>]+$/.test(String(u || '')); }
function hyperlink_(u, text) { return '=HYPERLINK("' + String(u).replace(/"/g, '""') + '","' + String(text).replace(/"/g, '""') + '")'; }
function hyperlinkUrl_(formula) { var m = /^=HYPERLINK\(\s*"((?:[^"]|"")*)"/i.exec(String(formula || '')); return m ? m[1].replace(/""/g, '"') : ''; }

// ---------- reading a tab ----------

function readTab_(sh) {
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { values: [], formulas: [], lastRow: 0, lastCol: 0 };
  var range = sh.getRange(1, 1, lastRow, lastCol);
  return { values: range.getValues(), formulas: range.getFormulas(), lastRow: lastRow, lastCol: lastCol };
}

// Finds the header row (0-based) containing every name in `need`, searching from `from`. Returns {row, col:{name:index}}.
function findHeader_(tab, need, from) {
  for (var r = from || 0; r < tab.values.length; r++) {
    var cells = tab.values[r].map(function (v) { return String(v).trim(); });
    if (need.every(function (n) { return cells.indexOf(n) >= 0; })) {
      var col = {};
      cells.forEach(function (n, i) { if (n && col[n] == null) col[n] = i; });
      return { row: r, col: col };
    }
  }
  return null;
}

function needSheet_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Tab "' + name + '" not found');
  return sh;
}

function requireHelpers_(h, tabName) {
  if (!h || h.col[SYNC.ID_HEADER] == null || h.col[SYNC.MARKER_HEADER] == null)
    throw new Error('Tab "' + tabName + '" needs the "' + SYNC.ID_HEADER + '" and "' + SYNC.MARKER_HEADER + '" header cells');
}

function isBanner_(row) { return /^\s*WEEK OF\b/i.test(String(row[0] || '')); }

// Normalises a cell for comparison: dates by day, times by minute, numbers rounded.
function norm_(v) {
  if (v instanceof Date) {
    if (v.getFullYear() < 1901) return 't' + (v.getHours() * 60 + v.getMinutes());
    return 'd' + v.getFullYear() + '-' + (v.getMonth() + 1) + '-' + v.getDate();
  }
  if (typeof v === 'number') return 'n' + Math.round(v * 1e6) / 1e6;
  return 's' + String(v == null ? '' : v).trim();
}
function sameCell_(cur, curFormula, next) {
  if (typeof next === 'string' && next.charAt(0) === '=') return String(curFormula) === next;
  if (curFormula) return false;
  if (typeof next === 'number' && cur instanceof Date && cur.getFullYear() < 1901) return norm_(cur) === 't' + Math.round(next * 1440);
  return norm_(cur) === norm_(next);
}

// Writes the given full-row arrays (only the columns in `cols`, 0-based) for rows that differ, in contiguous runs of rows
// and contiguous runs of columns: few Sheets calls per tab. rowsOut = [{r: 0-based row, cells: {colIndex: value}}].
function writeRuns_(sh, tab, rowsOut, cols, ctx, label) {
  cols = cols.slice().sort(function (a, b) { return a - b; });
  var spans = [], start = null;
  cols.forEach(function (c, i) { if (start == null) start = c; if (cols[i + 1] !== c + 1) { spans.push([start, c]); start = null; } });
  var changed = rowsOut.filter(function (o) {
    return cols.some(function (c) { return o.cells.hasOwnProperty(c) && !sameCell_(tab.values[o.r][c], tab.formulas[o.r][c], o.cells[c]); });
  }).sort(function (a, b) { return a.r - b.r; });
  ctx.counts.updated += changed.length;
  var runs = [];
  changed.forEach(function (o) { var last = runs[runs.length - 1]; if (last && last[last.length - 1].r === o.r - 1) last.push(o); else runs.push([o]); });
  runs.forEach(function (run) {
    spans.forEach(function (sp) {
      var block = run.map(function (o) {
        var row = [];
        for (var c = sp[0]; c <= sp[1]; c++) {
          if (o.cells.hasOwnProperty(c)) row.push(o.cells[c]);
          else row.push(tab.formulas[o.r][c] || tab.values[o.r][c]);
        }
        return row;
      });
      ctx.write(label + ': update rows ' + (run[0].r + 1) + '-' + (run[run.length - 1].r + 1) + ' cols ' + (sp[0] + 1) + '-' + (sp[1] + 1), function () {
        sh.getRange(run[0].r + 1, sp[0] + 1, block.length, block[0].length).setValues(block);
      });
    });
  });
  return changed;
}

// The "never blank" and "protected status" rules for one owned cell.
function mergeCell_(name, next, cur, curFormula, always) {
  if (name === 'Status' && SYNC.PROTECTED_STATUS.indexOf(String(cur).trim()) >= 0) return { keep: true };
  if ((next === '' || next == null) && always.indexOf(name) < 0) return { keep: true };
  return { value: next };
}

// ---------- applying: calendars (November, December) ----------

var CAL_OWNED = ['Owner', 'Post Date', 'Best Post Time', 'Status', 'Content', 'Audience (Persona)', 'Content Type',
  'Distribution Format', 'Campaign', 'Pillar', 'Caption Copy + CTA', 'Hashtags', 'Design Link'];
var CAL_ALWAYS = ['Post Date', 'Status'];

function calRead_(ss, tabName) {
  var sh = needSheet_(ss, tabName), tab = readTab_(sh);
  var h = findHeader_(tab, ['Owner', 'Post Date', 'Status', 'Content']);
  requireHelpers_(h, tabName);
  var ids = {};
  for (var r = h.row + 1; r < tab.values.length; r++) {
    var id = String(tab.values[r][h.col[SYNC.ID_HEADER]] || '').trim();
    if (id && !isBanner_(tab.values[r])) ids[id] = r;
  }
  return { sh: sh, tab: tab, h: h, ids: ids, name: tabName };
}

var APPLY_ = {};
APPLY_.cal = function (ss, target, ctx) {
  var names = Object.keys(SYNC.CAL_TABS).map(function (k) { return SYNC.CAL_TABS[k]; });
  var info = {}, carryDue = {};
  names.forEach(function (n) { info[n] = calRead_(ss, n); });
  // 1. Per tab: rows to cancel, rows to remove (moved to the other synced month).
  names.forEach(function (n) {
    var t = info[n], h = t.h, removeRows = [], cancelOut = [];
    Object.keys(t.ids).forEach(function (bid) {
      var r = t.ids[bid], want = target.rows[bid];
      if (want && want.tab === n) return;
      if (want && want.tab !== n) {
        if (h.col['Due Date'] != null) carryDue[bid] = { v: t.tab.values[r][h.col['Due Date']], f: t.tab.formulas[r][h.col['Due Date']] };
        removeRows.push(r); ctx.counts.moved++;
        return;
      }
      // deleted card, no date, or a month that is not synced: mark Cancelled, keep the row
      var st = String(t.tab.values[r][h.col['Status']] || '').trim();
      if (SYNC.PROTECTED_STATUS.indexOf(st) < 0) { var cells = {}; cells[h.col['Status']] = 'Cancelled'; cancelOut.push({ r: r, cells: cells }); }
      if (target.cancel[bid]) ctx.note(bid + ': ' + target.cancel[bid] + ', row marked Cancelled');
    });
    if (cancelOut.length) { ctx.counts.cancelled += cancelOut.length; writeRuns_(t.sh, t.tab, cancelOut, [h.col['Status']], ctx, n + ' cancel'); ctx.counts.updated -= cancelOut.length; }
    removeRows.sort(function (a, b) { return b - a; }).forEach(function (r) {
      ctx.write(n + ': remove moved row ' + (r + 1), function () { t.sh.deleteRow(r + 1); });
    });
    if (removeRows.length && !ctx.dry) info[n] = calRead_(ss, n);
  });
  // 2. Per tab: create missing rows in the right week, then update owned columns.
  names.forEach(function (n) {
    var t = info[n];
    var missing = Object.keys(target.rows).filter(function (bid) { return target.rows[bid].tab === n && t.ids[bid] == null; });
    var inserts = missing.map(function (bid) { return { bid: bid, after: weekAnchor_(t, target.rows[bid].date) }; })
      .sort(function (a, b) { return b.after - a.after; });
    inserts.forEach(function (ins) {
      ctx.counts.created++;
      var h = t.h, rowNo = ins.after + 2; // 1-based row of the new row
      ctx.write(n + ': insert row for ' + ins.bid + ' after row ' + (ins.after + 1), function () {
        t.sh.insertRowAfter(ins.after + 1);
        var ref = referenceRow_(t, ins.after);
        if (ref != null) { var ref1 = ref <= ins.after ? ref + 1 : ref + 2; t.sh.getRange(ref1, 1, 1, t.tab.lastCol).copyFormatToRange(t.sh, 1, t.tab.lastCol, rowNo, rowNo); }
        var a = h.col[SYNC.ID_HEADER], b = h.col[SYNC.MARKER_HEADER];
        var lo = Math.min(a, b), hi = Math.max(a, b), vals = [];
        for (var c = lo; c <= hi; c++) vals.push(c === a ? ins.bid : c === b ? SYNC.MARKER : '');
        t.sh.getRange(rowNo, lo + 1, 1, vals.length).setValues([vals]);
        var due = carryDue[ins.bid];
        if (due && h.col['Due Date'] != null && (due.f || due.v !== '')) t.sh.getRange(rowNo, h.col['Due Date'] + 1).setValue(due.f || due.v);
      });
    });
    if (ctx.dry) {
      // Dry run: nothing was inserted, so only existing rows can be compared.
    } else if (inserts.length) {
      t = info[n] = calRead_(ss, n);
    }
    var h = t.h, out = [], cols = [];
    CAL_OWNED.forEach(function (name) { if (h.col[name] != null) cols.push(h.col[name]); });
    cols.push(h.col[SYNC.MARKER_HEADER]);
    Object.keys(t.ids).forEach(function (bid) {
      var want = target.rows[bid];
      if (!want || want.tab !== n) return;
      var r = t.ids[bid], cells = {};
      CAL_OWNED.forEach(function (name) {
        var c = h.col[name];
        if (c == null) { if (want.cells[name]) ctx.note(n + ': no "' + name + '" column, value skipped'); return; }
        var m = mergeCell_(name, want.cells[name], t.tab.values[r][c], t.tab.formulas[r][c], CAL_ALWAYS);
        if (!m.keep) cells[c] = m.value;
      });
      cells[h.col[SYNC.MARKER_HEADER]] = SYNC.MARKER;
      out.push({ r: r, cells: cells });
    });
    writeRuns_(t.sh, t.tab, out, cols, ctx, n);
  });
};

// 0-based row index after which a card dated `date` is inserted: inside the week whose banner covers the date,
// after the last row in that week with a Post Date on or before it (else right after the banner).
function weekAnchor_(t, date) {
  var h = t.h, d = dateOnly_(date), pd = h.col['Post Date'], banners = [];
  var year = d.getFullYear();
  for (var r = h.row + 1; r < t.tab.values.length; r++) {
    if (!isBanner_(t.tab.values[r])) continue;
    var range = bannerRange_(String(t.tab.values[r][0]), year);
    banners.push({ r: r, range: range });
  }
  var lastData = h.row;
  for (var q = h.row + 1; q < t.tab.values.length; q++) if (t.tab.values[q].some(function (v) { return String(v) !== ''; })) lastData = q;
  var section = null;
  banners.forEach(function (b, i) {
    if (b.range && d >= b.range[0] && d <= b.range[1]) section = { from: b.r, to: (banners[i + 1] ? banners[i + 1].r - 1 : lastData) };
  });
  var from = section ? section.from : h.row, to = section ? section.to : lastData, anchor = from;
  for (var x = from + 1; x <= to; x++) {
    var v = t.tab.values[x][pd];
    if (isBanner_(t.tab.values[x])) { if (section) break; continue; }
    if (v instanceof Date && v <= d) anchor = x;
  }
  return anchor;
}

function bannerRange_(text, year) {
  var MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  var m = /WEEK OF\s+\w+,?\s+([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2})\s*[–—-]\s*\w+,?\s+([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2})/i.exec(text);
  if (!m) return null;
  var m1 = MON[m[1].toUpperCase()], m2 = MON[m[3].toUpperCase()];
  if (m1 == null || m2 == null) return null;
  var y2 = m2 < m1 ? year + 1 : year;
  return [new Date(year, m1, +m[2]), new Date(y2, m2, +m[4], 23, 59, 59)];
}

// A normal (non-banner) data row near `after` to copy formatting from.
function referenceRow_(t, after) {
  for (var r = after; r > t.h.row; r--) if (!isBanner_(t.tab.values[r])) return r;
  for (var q = after + 1; q < t.tab.values.length; q++) if (!isBanner_(t.tab.values[q])) return q;
  return null;
}

// ---------- applying: keyed blocks (Monthly Topics blocks, Content Mix, Document Map) ----------

// One generic routine: find the block's header, map Board ID -> row, remove rows whose id is gone (if allowed),
// insert rows for new ids after `anchorFor`, then update the owned columns in batched runs.
function applyBlock_(ss, spec, target, ctx) {
  var sh = needSheet_(ss, spec.tab);
  var read = function () {
    var tab = readTab_(sh), h = findHeader_(tab, spec.header, spec.from || 0);
    if (!h) throw new Error('Tab "' + spec.tab + '": header ' + spec.header.join(' | ') + ' not found');
    if (h.col[SYNC.ID_HEADER] == null || h.col[SYNC.MARKER_HEADER] == null) {
      var helper = findHeader_(tab, [SYNC.ID_HEADER, SYNC.MARKER_HEADER], 0);
      if (helper) { h.col[SYNC.ID_HEADER] = helper.col[SYNC.ID_HEADER]; h.col[SYNC.MARKER_HEADER] = helper.col[SYNC.MARKER_HEADER]; }
    }
    requireHelpers_(h, spec.tab);
    var ids = {}, end = h.row;
    for (var r = h.row + 1; r < tab.values.length; r++) {
      var row = tab.values[r];
      if (spec.stopAtBlank && String(row[0]).trim() === '' && String(row[h.col[SYNC.ID_HEADER]]).trim() === '') break;
      end = r;
      var id = String(row[h.col[SYNC.ID_HEADER]] || '').trim();
      if (id) ids[id] = r;
    }
    return { tab: tab, h: h, ids: ids, end: end };
  };
  var t = read(), wanted = {};
  target.rows.forEach(function (row) { wanted[row.id] = row; });
  // remove
  if (spec.removeGone) {
    var gone = Object.keys(t.ids).filter(function (id) { return !wanted[id]; }).map(function (id) { return t.ids[id]; }).sort(function (a, b) { return b - a; });
    gone.forEach(function (r) { ctx.counts.removed++; ctx.write(spec.tab + ': remove row ' + (r + 1), function () { sh.deleteRow(r + 1); }); });
    if (gone.length && !ctx.dry) t = read();
  }
  // insert
  var missing = target.rows.filter(function (row) { return t.ids[row.id] == null; });
  if (missing.length) {
    var plan = missing.map(function (row) { return { row: row, after: spec.anchorFor ? spec.anchorFor(t, row) : lastIdRow_(t) }; })
      .sort(function (a, b) { return b.after - a.after; });
    plan.forEach(function (p) {
      ctx.counts.created++;
      ctx.write(spec.tab + ': insert row for ' + p.row.id + ' after row ' + (p.after + 1), function () {
        sh.insertRowAfter(p.after + 1);
        var ref1 = p.after > t.h.row ? p.after + 1 : p.after + 3; // 1-based: the row above, or the first data row (now pushed down)
        sh.getRange(ref1, 1, 1, t.tab.lastCol).copyFormatToRange(sh, 1, t.tab.lastCol, p.after + 2, p.after + 2);
        sh.getRange(p.after + 2, t.h.col[SYNC.ID_HEADER] + 1).setValue(p.row.id);
      });
    });
    if (!ctx.dry) t = read();
  }
  // update
  var cols = spec.owned.map(function (i) { return i; }).concat([t.h.col[SYNC.MARKER_HEADER]]);
  var out = [];
  target.rows.forEach(function (row) {
    var r = t.ids[row.id];
    if (r == null) return;
    var cells = {};
    row.cells.forEach(function (v, i) {
      var c = spec.owned[i];
      if (v === null) v = spec.cellFn ? spec.cellFn(row, t, r) : null;
      if (v === null || v === '' || v == null) return; // never blank a cell
      cells[c] = v;
    });
    cells[t.h.col[SYNC.MARKER_HEADER]] = SYNC.MARKER;
    out.push({ r: r, cells: cells });
  });
  var changed = writeRuns_(sh, t.tab, out, cols, ctx, spec.tab);
  if (spec.formats) spec.formats(sh, t, changed, ctx);
}

function lastIdRow_(t) {
  var last = t.h.row;
  Object.keys(t.ids).forEach(function (id) { if (t.ids[id] > last) last = t.ids[id]; });
  return Object.keys(t.ids).length ? last : t.end;
}

APPLY_.topics1 = function (ss, target, ctx) {
  applyBlock_(ss, { tab: SYNC.TOPICS_TAB, header: ['Recurring Theme', 'What It Covers'], owned: [0, 1, 2, 3],
    stopAtBlank: true, removeGone: true }, target, ctx);
};
APPLY_.topics2 = function (ss, target, ctx) {
  applyBlock_(ss, { tab: SYNC.TOPICS_TAB, header: ['Month', 'Monthly Theme'], owned: [0, 1, 2, 3],
    stopAtBlank: true, removeGone: false }, target, ctx);
};
APPLY_.mix = function (ss, target, ctx) {
  applyBlock_(ss, { tab: SYNC.MIX_TAB, header: ['Month', 'Educational %'], owned: [0, 1, 2, 3, 4, 5, 6],
    removeGone: false,
    formats: function (sh, t, changed, ctx) {
      // Normalise the four percentage cells to fractions shown as 0%.
      var rows = changed.map(function (o) { return o.r; }).sort(function (a, b) { return a - b; }), runs = [];
      rows.forEach(function (r) { var l = runs[runs.length - 1]; if (l && l[1] === r - 1) l[1] = r; else runs.push([r, r]); });
      runs.forEach(function (run) {
        ctx.write(SYNC.MIX_TAB + ': percent format rows ' + (run[0] + 1) + '-' + (run[1] + 1), function () {
          sh.getRange(run[0] + 1, 3, run[1] - run[0] + 1, 4).setNumberFormat('0%');
        });
      });
    } }, target, ctx);
};
APPLY_.docs = function (ss, target, ctx) {
  applyBlock_(ss, { tab: SYNC.DOCS_TAB, header: ['Level', 'Document', 'Answers'], owned: [0, 1, 2, 3], removeGone: true,
    // Links come from the matrix: keep the matrix's URL when the cell already has one; the board's URL only for new rows.
    cellFn: function (row, t, r) {
      var url = hyperlinkUrl_(t.tab.formulas[r][1]) || row.url;
      return url ? hyperlink_(url, row.name) : row.name;
    },
    anchorFor: function (t, row) {
      var last = -1;
      for (var r = t.h.row + 1; r <= t.end; r++) if (String(t.tab.values[r][0]).trim() === row.level) last = r;
      return last >= 0 ? last : lastIdRow_(t);
    } }, target, ctx);
};
