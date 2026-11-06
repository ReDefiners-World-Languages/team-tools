// One-way mirror: Board store (master) -> the typed tables of the workbook. Nothing private lives in this file.
//
// WHY A DIRTY LIST AND A ONE-MINUTE TRIGGER (and not a write inside every save)
//  - A save then costs the same as before the tables existed (one store read, one or two writes, under the lock). The
//    tables never slow a save and a table problem never blocks a save.
//  - The table work is batched: however many saves happen in a minute, the trigger writes each touched table once,
//    only the rows that really differ. At most (touched tabs x (1 read + a few runs of rows)) calls per minute, far under
//    a 60 reads / 60 writes per minute limit, while a write-inside-every-save design grows with every autosave.
//  - Cost when nothing changed: one Properties read per minute (about 1,440 a day of the 500,000 allowed) and well
//    under 6 hours/day of trigger time.
//  The tables therefore trail the board by up to about 1 to 2 minutes.
//
// RULES
//  - Items are written by id into their own rows (typed values, month keys as text, ", " between several values, child
//    tables for links/notes/shots). Rows are never inserted, sorted or deleted: a removed item's row is cleared and reused.
//  - A hand edit in a table cell is overwritten the next time that item is saved on the board (or by fullSyncToTables).
//    Nothing in a table is ever read back into the board; only the import (Import.gs, run by hand) reads the tables.
//  - Switch: Script Property SYNC_ENABLED = true. Off = the tables are not touched and saves do not list dirty items.
//    SYNC_DRY_RUN = true makes the trigger only log what it would write.

var SY_UNIT_COLLS = ['cards', 'topics', 'themes', 'camps', 'docs', 'classes', 'visits'];
var SY_LEASE_MS = 6 * 60 * 1000;
var TB_GROW_AT = 0.9;

function sy_enabled_() { return prop_('SYNC_ENABLED', '') === 'true'; }

// ---------- dirty list ----------

// Called inside the save lock. keys = ['cards|12', 'single|people', ...]
function sy_markDirty_(keys) {
  if (!keys.length || !sy_enabled_()) return;
  var p = PropertiesService.getScriptProperties(), map;
  try { map = JSON.parse(p.getProperty('SYNC_DIRTY') || '{}'); } catch (e) { map = {}; }
  keys.forEach(function (k) { map[k] = (map[k] || 0) + 1; });
  var s = JSON.stringify(map);
  if (s.length > 8000) { map = { '*': (map['*'] || 0) + 1 }; s = JSON.stringify(map); } // a property holds 9 KB: fall back to a full comparison
  p.setProperty('SYNC_DIRTY', s);
}

function sy_readDirty_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('SYNC_DIRTY') || '{}'); } catch (e) { return {}; }
}

// Removes the keys that were handled, but only if nobody changed them again meanwhile.
function sy_clearDirty_(snapshot, keep) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    var cur = sy_readDirty_();
    Object.keys(snapshot).forEach(function (k) { if (!keep[k] && cur[k] === snapshot[k]) delete cur[k]; });
    var p = PropertiesService.getScriptProperties();
    if (Object.keys(cur).length) p.setProperty('SYNC_DIRTY', JSON.stringify(cur)); else p.deleteProperty('SYNC_DIRTY');
  } finally { lock.releaseLock(); }
}

// ---------- lease (separate from the save lock, so saves are never held up by a table sync) ----------

function sy_lease_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return null;
  try {
    var p = PropertiesService.getScriptProperties(), cur = p.getProperty('SYNC_LEASE'), now = nowMs_();
    if (cur && now - Number(String(cur).split('|')[0]) < SY_LEASE_MS) return null;
    var token = now + '|' + Math.floor(Math.random() * 1e9);
    p.setProperty('SYNC_LEASE', token);
    return token;
  } finally { lock.releaseLock(); }
}
function sy_release_(token) {
  var lock = LockService.getScriptLock();
  var got = lock.tryLock(5000);
  try {
    var p = PropertiesService.getScriptProperties();
    if (p.getProperty('SYNC_LEASE') === token) p.deleteProperty('SYNC_LEASE');
  } finally { if (got) lock.releaseLock(); }
}

// ---------- reading a typed table ----------

// Reads header + data rows with ONE getDisplayValues call (dates, times and percents are parsed from what Sheets shows,
// which avoids Date objects and time-zone offsets). The first N columns must be exactly the expected headers.
function tb_readTable_(tabKey, opts) {
  opts = opts || {};
  var spec = TB[tabKey], sh = ss_open_().getSheetByName(spec.tab);
  if (!sh) throw userError_('not_set_up', 'The tab "' + spec.tab + '" is missing from the workbook.');
  var n = spec.cols.length;
  if (sh.getMaxColumns() < n) throw userError_('not_set_up', 'The tab "' + spec.tab + '" has fewer than ' + n + ' columns.');
  var last = opts.headerOnly ? 1 : Math.max(1, Math.min(sh.getLastRow(), sh.getMaxRows()));
  var width = n + (spec.optional ? Math.min(spec.optional.length, sh.getMaxColumns() - n) : 0);
  var grid = sh.getRange(1, 1, last, width).getDisplayValues();
  spec.cols.forEach(function (c, i) {
    if (String(grid[0][i]).trim() !== c[0]) throw userError_('not_set_up', 'Tab "' + spec.tab + '": column ' + (i + 1) + ' must be "' + c[0] + '" but is "' + String(grid[0][i]).trim() + '". Do not insert or move columns inside a table; add new columns to the right of "Updated by".');
  });
  var cols = spec.cols.slice();
  (spec.optional || []).every(function (o, i) {
    if (n + i < width && String(grid[0][n + i]).trim() === o[0]) { cols.push(o); return true; }
    return false;
  });
  var t = { tabKey: tabKey, spec: spec, cols: cols, sh: sh, cap: sh.getMaxRows() - 1, rows: [], byKey: {}, holes: [], lastRow: 1, warnings: [], dup: 0, orphans: 0 };
  if (opts.headerOnly) return t;
  for (var i = 1; i < last; i++) {
    var cells = grid[i], row = i + 1;
    if (cells.every(function (v) { return v === ''; })) { t.holes.push(row); continue; }
    var obj = {};
    cols.forEach(function (c, j) { obj[c[0]] = tb_decodeCell_(c[1], cells[j], function (m) { t.warnings.push(spec.tab + ' row ' + row + ' ' + c[0] + ': ' + m); }); });
    var key = String(obj[spec.key]);
    t.lastRow = row;
    if (key === '') { t.orphans++; t.warnings.push(spec.tab + ' row ' + row + ' has data but no ' + spec.key + ' (left alone)'); continue; }
    if (t.byKey[key]) { t.dup++; t.warnings.push(spec.tab + ' row ' + row + ' repeats ' + spec.key + ' ' + key + ' (ignored)'); continue; }
    var ent = { row: row, obj: obj, key: key };
    t.rows.push(ent);
    t.byKey[key] = ent;
  }
  t.holes = t.holes.filter(function (r) { return r < t.lastRow; });
  return t;
}

// ---------- writing a typed table ----------

function tb_rowValues_(t, obj) {
  var spec = t.spec;
  return t.cols.map(function (c) {
    var v = obj[c[0]];
    if ((c[1] === 'text' || c[1] === 'long') && typeof v === 'string' && v.length > TB_CELL_MAX) {
      throw userError_('too_big', 'Tab "' + spec.tab + '", ' + c[0] + ' of ' + obj[spec.key] + ' is ' + v.length + ' characters; the cell limit guard is ' + TB_CELL_MAX + '.');
    }
    return tb_encodeCell_(c[1], v);
  });
}

// Writes rows as runs of consecutive rows; forces the text format first only when a text cell could be misread.
function tb_writeRows_(t, rows) {
  var spec = t.spec, n = t.cols.length;
  rows.sort(function (a, b) { return a.row - b.row; });
  var i = 0, calls = 0;
  while (i < rows.length) {
    var j = i;
    while (j + 1 < rows.length && rows[j + 1].row === rows[j].row + 1) j++;
    var run = rows.slice(i, j + 1), range = t.sh.getRange(run[0].row, 1, run.length, n);
    var risky = run.some(function (r) { return t.cols.some(function (c, k) { return (c[1] === 'text' || c[1] === 'long') && tb_risky_(r.values[k]); }); });
    if (risky) {
      // Columns of a Sheets table are typed and refuse setNumberFormats ("You can't set the number format of cells in a
      // typed column"). The typed column already holds text, so on that error write the values as they are.
      try { range.setNumberFormats(run.map(function () { return t.cols.map(function (c) { return TB_FORMATS[c[1]]; }); })); calls++; }
      catch (e) { if (String(e && e.message).indexOf('typed column') < 0) throw e; }
    }
    range.setValues(run.map(function (r) { return r.values; }));
    calls++;
    i = j + 1;
  }
  return calls;
}

function tb_clearRows_(t, rowNums) {
  rowNums.sort(function (a, b) { return a - b; });
  var i = 0, calls = 0, n = t.cols.length;
  while (i < rowNums.length) {
    var j = i;
    while (j + 1 < rowNums.length && rowNums[j + 1] === rowNums[j] + 1) j++;
    t.sh.getRange(rowNums[i], 1, j - i + 1, n).clearContent();
    calls++;
    i = j + 1;
  }
  return calls;
}

// Adds rows at the END of the tab (never inserts between rows) and, where the Sheets advanced service is on, extends the
// Sheets table range to match. Without it the rows are still added and used; only the table banding/range stops short.
function tb_grow_(t, newCap) {
  var add = newCap - t.cap;
  if (add <= 0) return false;
  t.sh.insertRowsAfter(t.sh.getMaxRows(), add);
  t.warnings.push('"' + t.spec.tab + '" grew from ' + t.cap + ' to ' + newCap + ' rows.');
  try {
    if (typeof Sheets !== 'undefined') {
      var meta = Sheets.Spreadsheets.get(prop_('SHEET_ID', ''), { fields: 'sheets(properties(sheetId),tables(tableId,range))' });
      meta.sheets.forEach(function (s) {
        if (s.properties.sheetId !== t.sh.getSheetId()) return;
        (s.tables || []).forEach(function (tb) {
          var r = tb.range;
          r.endRowIndex = newCap + 1;
          Sheets.Spreadsheets.batchUpdate({ requests: [{ updateTable: { table: { tableId: tb.tableId, range: r }, fields: 'range' } }] }, prop_('SHEET_ID', ''));
        });
      });
    }
  } catch (e) {
    t.warnings.push('Rows were added to "' + t.spec.tab + '" but the Sheets table range could not be extended (' + String(e.message).slice(0, 120) + '). Ask for the table range to be enlarged.');
  }
  t.cap = newCap;
  return true;
}

// Rows for new keys: cleared rows first, then rows after the last used one. Grows the tab near capacity.
function tb_allocate_(t, count) {
  var rows = [], holes = t.holes.slice().sort(function (a, b) { return a - b; }), next = t.lastRow + 1;
  for (var i = 0; i < count; i++) rows.push(holes.length ? holes.shift() : next++);
  var highest = Math.max.apply(null, rows.concat([1]));
  var used = t.rows.length + count;
  if (highest > t.cap + 1 || used > TB_GROW_AT * t.cap) {
    var target = Math.min(t.spec.max, Math.max(Math.ceil(t.cap * 1.5), t.cap + 50, highest - 1));
    tb_grow_(t, target);
    if (highest > t.cap + 1) throw userError_('full', 'The tab "' + t.spec.tab + '" is full (' + t.cap + ' rows; the script adds rows itself up to ' + t.spec.max + ').');
  }
  return rows;
}

// ---------- store -> expected table rows ----------

function sy_loadStore_() {
  var data = st_load_(store_()), s = { coll: {}, single: {}, recs: {}, items: data.items.length, bad: 0 };
  data.items.forEach(function (it) {
    var v = st_parse_(it);
    if (v == null) { s.bad++; return; }
    var rec = { at: it.at, by: it.by };
    if (it.c === 'single') { s.single[it.id] = v; s.recs['single|' + it.id] = rec; }
    else { (s.coll[it.c] = s.coll[it.c] || {})[it.id] = v; s.recs[it.c + '|' + it.id] = rec; }
  });
  return s;
}

function sy_ctx_(s) {
  var themeName = {};
  Object.keys(s.coll.themes || {}).forEach(function (id) { themeName[id] = String(s.coll.themes[id].n || ''); });
  return { lists: st_lists_(), themeName: themeName };
}

function sy_allUnits_(s) {
  var u = [], seen = {};
  SY_UNIT_COLLS.forEach(function (c) { Object.keys(s.coll[c] || {}).forEach(function (id) { u.push({ t: c, id: id }); }); });
  [].concat(Object.keys(s.coll.mix || {}), Object.keys(s.coll.meta || {})).forEach(function (m) { if (!seen[m]) { seen[m] = 1; u.push({ t: 'months', id: m }); } });
  ['pillars', 'personas', 'people', 'settings'].forEach(function (t) { u.push({ t: t, id: '*' }); });
  return u;
}

function sy_unitsFromDirty_(keys, s) {
  var seen = {}, u = [];
  var add = function (t, id) { var k = t + '|' + id; if (!seen[k]) { seen[k] = 1; u.push({ t: t, id: id }); } };
  keys.forEach(function (k) {
    var i = k.indexOf('|'), c = k.slice(0, i), id = k.slice(i + 1);
    if (SY_UNIT_COLLS.indexOf(c) >= 0) {
      add(c, id);
      if (c === 'themes') Object.keys(s.coll.cards || {}).forEach(function (cid) { if (String(s.coll.cards[cid].theme) === id) add('cards', cid); }); // a renamed theme changes its cards' Content Theme cells
    } else if (c === 'mix' || c === 'meta') add('months', id);
    else if (c === 'single') {
      if (id === 'pillars' || id === 'pillarType') add('pillars', '*');
      else if (id === 'personas' || id === 'people') add(id, '*');
      else if (id === 'texts' || id === 'links') add('settings', '*');
    }
  });
  return u;
}

var SY_WHOLE = { pillars: 'pillars', personas: 'personas', people: 'people', settings: 'settings' };

// Expected rows of one unit: { tabKey: [row, ...] }. Throws a userError when the item cannot be written (e.g. a comma).
function sy_forward_(u, s, ctx) {
  var rec = function (k) { return s.recs[k]; };
  if (u.t === 'months') {
    var mix = (s.coll.mix || {})[u.id], meta = (s.coll.meta || {})[u.id];
    if (!mix && !meta) return {};
    return TB_FORWARD.months(u.id, { mix: mix, meta: meta }, ctx, tb_latest_([rec('mix|' + u.id), rec('meta|' + u.id)]));
  }
  if (u.t === 'pillars') return { pillars: tb_forwardPillars_({ pillars: s.single.pillars, pillarType: s.single.pillarType }, { pillars: rec('single|pillars'), pillarType: rec('single|pillarType') }) };
  if (u.t === 'personas') return { personas: tb_forwardPersonas_({ personas: s.single.personas }, { personas: rec('single|personas') }) };
  if (u.t === 'people') return { people: tb_forwardPeople_({ people: s.single.people }, { people: rec('single|people') }) };
  if (u.t === 'settings') return { settings: tb_forwardSettings_({ texts: s.single.texts, links: s.single.links }, { texts: rec('single|texts'), links: rec('single|links') }) };
  var item = (s.coll[u.t] || {})[u.id];
  if (item == null) return {};
  return TB_FORWARD[u.t](u.id, item, ctx, rec(u.t + '|' + u.id));
}

// The tabs a unit may write to or clear rows in.
function sy_tabsOf_(u) {
  return { cards: ['cards', 'cardLinks', 'cardNotes'], visits: ['visits', 'visitShots'] }[u.t] || [u.t];
}

// Existing table keys that belong to a unit (so they can be cleared when the unit is gone or shorter).
function sy_owned_(u, getTable) {
  var out = {};
  var add = function (tab, key) { (out[tab] = out[tab] || {})[key] = true; };
  if (SY_WHOLE[u.t]) { getTable(u.t).rows.forEach(function (r) { add(u.t, r.key); }); return out; }
  add(u.t, u.id);
  if (u.t === 'cards' || u.t === 'visits') {
    [['cardLinks', 'cards'], ['cardNotes', 'cards'], ['visitShots', 'visits']].forEach(function (p) {
      if (p[1] !== u.t) return;
      var t = getTable(p[0]), pc = t.spec.parent;
      t.rows.forEach(function (r) { if (String(r.obj[pc]) === u.id) add(p[0], r.key); });
    });
  }
  return out;
}

function tb_diffFields_(cols, a, b) {
  var out = [];
  cols.forEach(function (c) {
    if (c[0] === 'Updated at' || c[0] === 'Updated by') return;
    var x = a[c[0]], y = b[c[0]];
    var nx = typeof x === 'string' ? x.replace(/\r\n?/g, '\n') : String(x == null ? '' : x);
    var ny = typeof y === 'string' ? y.replace(/\r\n?/g, '\n') : String(y == null ? '' : y);
    if (nx !== ny) out.push(c[0]);
  });
  return out;
}

// Builds the plan: for every touched tab which rows to update, insert and clear. mode 'all' also clears every table
// row that has no item in the store.
function sy_plan_(units, s, ctx, getTable, all) {
  var desired = {}, owned = {}, errors = [], failed = {}, i;
  units.forEach(function (u) {
    var fwd;
    try { fwd = sy_forward_(u, s, ctx); }
    catch (e) { if (!e.userCode) throw e; errors.push(u.t + ' ' + u.id + ': ' + e.message); failed[u.t + '|' + u.id] = true; return; }
    Object.keys(fwd).forEach(function (tab) {
      (fwd[tab] || []).forEach(function (row) { (desired[tab] = desired[tab] || {})[String(row[TB[tab].key])] = row; });
    });
    var own = sy_owned_(u, getTable);
    Object.keys(own).forEach(function (tab) { owned[tab] = owned[tab] || {}; Object.keys(own[tab]).forEach(function (k) { owned[tab][k] = true; }); });
    sy_tabsOf_(u).forEach(function (tab) { desired[tab] = desired[tab] || {}; owned[tab] = owned[tab] || {}; });
  });
  if (all) Object.keys(TB).forEach(function (tab) {
    desired[tab] = desired[tab] || {};
    owned[tab] = owned[tab] || {};
    getTable(tab).rows.forEach(function (r) { owned[tab][r.key] = true; });
  });
  var plan = { tabs: {}, errors: errors, failed: failed };
  Object.keys(desired).concat(Object.keys(owned)).filter(function (v, k, a) { return a.indexOf(v) === k; }).forEach(function (tab) {
    var t = getTable(tab), p = { updates: [], inserts: [], deletes: [], same: 0 }, des = desired[tab] || {}, own = owned[tab] || {};
    Object.keys(des).forEach(function (key) {
      var ex = t.byKey[key], row = des[key];
      if (!ex) p.inserts.push({ key: key, obj: row });
      else {
        var d = tb_diffFields_(t.cols, ex.obj, row);
        if (d.length) p.updates.push({ key: key, row: ex.row, obj: row, fields: d, before: ex.obj }); else p.same++;
      }
    });
    Object.keys(own).forEach(function (key) { if (!(key in des) && t.byKey[key]) p.deletes.push({ key: key, row: t.byKey[key].row }); });
    plan.tabs[tab] = p;
  });
  return plan;
}

function sy_planCounts_(plan) {
  var c = { updates: 0, inserts: 0, deletes: 0, same: 0 };
  Object.keys(plan.tabs).forEach(function (tab) { var p = plan.tabs[tab]; c.updates += p.updates.length; c.inserts += p.inserts.length; c.deletes += p.deletes.length; c.same += p.same; });
  return c;
}

// Executes a plan. Returns the number of write calls made.
function sy_apply_(plan, getTable) {
  var calls = 0;
  Object.keys(plan.tabs).forEach(function (tab) {
    var p = plan.tabs[tab];
    if (!p.updates.length && !p.inserts.length && !p.deletes.length) return;
    var t = getTable(tab), rows = [];
    p.updates.forEach(function (u) { rows.push({ row: u.row, values: tb_rowValues_(t, u.obj) }); });
    if (p.inserts.length) {
      var alloc = tb_allocate_(t, p.inserts.length);
      p.inserts.forEach(function (ins, i) { rows.push({ row: alloc[i], values: tb_rowValues_(t, ins.obj) }); });
    }
    if (rows.length) calls += tb_writeRows_(t, rows);
    if (p.deletes.length) calls += tb_clearRows_(t, p.deletes.map(function (d) { return d.row; }));
  });
  return calls;
}

// ---------- running a sync ----------

function sy_status_(patch) {
  var p = PropertiesService.getScriptProperties(), cur = {};
  try { cur = JSON.parse(p.getProperty('SYNC_STATUS') || '{}'); } catch (e) { cur = {}; }
  Object.keys(patch).forEach(function (k) { cur[k] = patch[k]; });
  p.setProperty('SYNC_STATUS', JSON.stringify(cur));
}

// opts: { all: bool, dry: bool, keys: [...] }. Returns { counts, plan, calls, errors, warnings }.
function sy_run_(opts) {
  ss_ = null;
  var tables = {}, warnings = [];
  var getTable = function (tab) { if (!tables[tab]) { tables[tab] = tb_readTable_(tab); warnings = warnings.concat(tables[tab].warnings); } return tables[tab]; };
  var s = sy_loadStore_(), ctx = sy_ctx_(s);
  var units = opts.all ? sy_allUnits_(s) : sy_unitsFromDirty_(opts.keys, s);
  var plan = sy_plan_(units, s, ctx, getTable, !!opts.all);
  var counts = sy_planCounts_(plan), calls = 0;
  if (!opts.dry) calls = sy_apply_(plan, getTable);
  Object.keys(tables).forEach(function (k) { warnings = warnings.concat(tables[k].warnings.filter(function (w) { return w.indexOf('grew') >= 0 || w.indexOf('extended') >= 0; })); });
  return { counts: counts, plan: plan, calls: calls, errors: plan.errors, failed: plan.failed, warnings: warnings.filter(function (w, i, a) { return a.indexOf(w) === i; }), storeItems: s.items, storeBad: s.bad, units: units.length };
}

// The one-minute trigger.
function syncTick() {
  if (!sy_enabled_()) return;
  var dirty = sy_readDirty_(), keys = Object.keys(dirty);
  if (!keys.length) return;
  var lease = sy_lease_();
  if (!lease) return;
  try {
    var all = !!dirty['*'];
    var res = sy_run_({ all: all, dry: prop_('SYNC_DRY_RUN', '') === 'true', keys: keys });
    var dry = prop_('SYNC_DRY_RUN', '') === 'true';
    if (dry) { Logger.log('SYNC DRY RUN (nothing written): ' + JSON.stringify(res.counts)); sy_report_(res, 15); }
    else sy_clearDirty_(dirty, res.failed);
    sy_status_({ lastRun: new Date(nowMs_()).toISOString(), lastOk: res.errors.length ? undefined : new Date(nowMs_()).toISOString(), error: res.errors.length ? res.errors.slice(0, 3).join(' | ') : '', counts: res.counts, calls: res.calls, dry: dry });
  } catch (e) {
    console.error(e && e.stack ? e.stack : e);
    sy_status_({ lastRun: new Date(nowMs_()).toISOString(), error: String(e.message || e).slice(0, 300) });
  } finally {
    sy_release_(lease);
  }
}

// Same as the trigger, right now (editor).
function syncNow() {
  if (!sy_enabled_()) throw new Error('SYNC_ENABLED is not true. Set the Script Property SYNC_ENABLED = true first.');
  var lease = sy_lease_();
  if (!lease) throw new Error('A sync is already running (or ran in the last 6 minutes and did not finish). Try again in a few minutes.');
  try {
    var dirty = sy_readDirty_(), keys = Object.keys(dirty);
    var res = sy_run_({ all: !!dirty['*'], dry: false, keys: keys });
    sy_clearDirty_(dirty, res.failed);
    Logger.log('Synced ' + keys.length + ' dirty item(s): ' + JSON.stringify(res.counts) + ', ' + res.calls + ' write call(s).');
    sy_report_(res, 15);
  } finally { sy_release_(lease); }
}

function sy_report_(res, maxLines) {
  var lines = [];
  Object.keys(res.plan.tabs).forEach(function (tab) {
    var p = res.plan.tabs[tab];
    if (!p.updates.length && !p.inserts.length && !p.deletes.length) return;
    lines.push(TB[tab].tab + ': ' + p.updates.length + ' to update, ' + p.inserts.length + ' to add, ' + p.deletes.length + ' to clear, ' + p.same + ' already equal');
    p.updates.slice(0, 5).forEach(function (u) { lines.push('   update ' + u.key + ': ' + u.fields.join(', ')); });
    p.inserts.slice(0, 3).forEach(function (u) { lines.push('   add    ' + u.key); });
    p.deletes.slice(0, 3).forEach(function (u) { lines.push('   clear  ' + u.key + ' (not in the board store)'); });
  });
  res.errors.forEach(function (e) { lines.push('ERROR ' + e); });
  res.warnings.forEach(function (w) { lines.push('NOTE ' + w); });
  lines.slice(0, maxLines * 8).forEach(function (l) { Logger.log(l); });
  return lines;
}

// ---------- full comparison, verify and full rebuild (editor) ----------

function sy_requireStore_(s) {
  if (!s.items) throw new Error('The Board store is empty. Run importFromTables first; a full sync of an empty store would clear every table.');
}

// Compares the whole store with all 15 tables. Writes nothing. Differences are listed; "0 differences" means the tables
// equal what the board holds.
function verifyStoreAgainstTables() {
  var res = sy_run_({ all: true, dry: true, keys: [] });
  if (!res.storeItems) throw new Error('The Board store is empty, so there is nothing to compare. Run importFromTables first.');
  var c = res.counts, diffs = c.updates + c.inserts + c.deletes;
  Logger.log('VERIFY: ' + res.storeItems + ' store items, ' + res.units + ' units. ' + (diffs === 0 && !res.errors.length ? '0 differences: the tables equal the board store.' : diffs + ' difference(s): ' + c.updates + ' row(s) differ, ' + c.inserts + ' missing in a table, ' + c.deletes + ' table row(s) with no item in the store.'));
  sy_report_(res, 40).forEach(function () {});
  return { differences: diffs, counts: c, errors: res.errors };
}

function fullSyncToTablesDryRun() {
  var res = sy_run_({ all: true, dry: true, keys: [] });
  sy_requireStore_({ items: res.storeItems });
  Logger.log('FULL SYNC DRY RUN (nothing written): ' + JSON.stringify(res.counts));
  sy_report_(res, 40);
  return res.counts;
}

// Rebuilds every table from the store: updates changed rows, adds missing ones and CLEARS rows that have no item in the
// store (so hand-added rows disappear). Run the dry run first.
function fullSyncToTables() {
  var lease = sy_lease_();
  if (!lease) throw new Error('A sync is already running. Try again in a few minutes.');
  try {
    var dirty = sy_readDirty_();
    var res = sy_run_({ all: true, dry: false, keys: [] });
    sy_requireStore_({ items: res.storeItems });
    sy_clearDirty_(dirty, res.failed);
    Logger.log('FULL SYNC DONE: ' + JSON.stringify(res.counts) + ', ' + res.calls + ' write call(s).');
    sy_report_(res, 40);
    return res.counts;
  } finally { sy_release_(lease); }
}

// ---------- trigger (installed by hand) ----------

function installSyncTrigger() {
  removeSyncTrigger();
  ScriptApp.newTrigger('syncTick').timeBased().everyMinutes(1).create();
  Logger.log('syncTick will run every minute. It does nothing unless SYNC_ENABLED = true.');
}
function removeSyncTrigger() {
  var n = 0;
  ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'syncTick'; }).forEach(function (t) { ScriptApp.deleteTrigger(t); n++; });
  Logger.log(n + ' syncTick trigger(s) removed.');
}
