// One-time and on-request import: the typed tables -> the Board store. Run from the script editor only; there is no web
// action that calls these functions, so nobody can trigger them from the board or the page.
//
//   importFromTables()         First-time load. Refuses if the Board store already holds any item.
//   importFromTablesReplace()  Explicit replace. First copies the current store into a new tab named
//                              "Board store backup yyyy-MM-dd HHmm" (same 5 columns, as text), then replaces it.
//   verifyStoreAgainstTables() (TableSync.gs) compares the store with the tables and lists any difference.
//
// The import applies the same codec as the sync, in reverse (TableSync.gs / Codec.gs). It logs how many items it loaded
// per kind and every value it could not translate (for example a stage that is not in Lists). It writes nothing to the
// typed tables. After it, run verifyStoreAgainstTables(): "0 differences" proves the tables equal the board's data.

function importFromTables() { return im_run_(false); }
function importFromTablesReplace() { return im_run_(true); }

function im_run_(replace) {
  ss_ = null;
  var lease = sy_lease_();
  if (!lease) throw new Error('A table sync is running. Try again in a few minutes.');
  var summary;
  try {
    summary = withLock_(30000, function () { return im_do_(replace); });
  } finally { sy_release_(lease); }
  Logger.log('Now run verifyStoreAgainstTables to compare the store with the tables.');
  return summary;
}

function im_who_() {
  var e = ''; try { e = Session.getEffectiveUser().getEmail(); } catch (x) { e = ''; }
  return 'import from tables' + (e ? ' (' + e + ')' : '');
}

function im_do_(replace) {
  var sh = store_(), data = st_load_(sh), lists = st_lists_();
  if (data.items.length && !replace) {
    throw new Error('The Board store already holds ' + data.items.length + ' item(s). Import stopped so nothing is overwritten. To replace it on purpose run importFromTablesReplace (the current store is copied to a backup tab first).');
  }
  // 1. read the tables
  var tables = {}, warnings = [];
  Object.keys(TB).forEach(function (k) {
    var t = tb_readTable_(k);
    warnings = warnings.concat(t.warnings);
    tables[k] = t.rows.map(function (r) { return r.obj; });
  });
  // 2. reverse codec
  var rev = tb_reverse_(tables, { lists: lists }), board = rev.board;
  warnings = warnings.concat(rev.warnings);
  // 3. store rows
  var items = [], tooBig = [];
  var add = function (c, id, v) {
    var json = JSON.stringify(v);
    if (json.length > MAX_JSON) { tooBig.push(c + ' ' + id + ' (' + json.length + ' characters)'); return; }
    items.push([c, String(id), json]);
  };
  ['camps', 'themes', 'topics', 'docs', 'classes', 'visits', 'cards'].forEach(function (c) { board[c].forEach(function (v) { add(c, v.id, v); }); });
  Object.keys(board.mix).forEach(function (m) { add('mix', m, board.mix[m]); });
  Object.keys(board.meta).forEach(function (m) { add('meta', m, board.meta[m]); });
  SINGLES.forEach(function (k) { add('single', k, board[k]); });
  if (tooBig.length) throw new Error('Import stopped before writing anything: these items are too large for one store cell (limit ' + MAX_JSON + '): ' + tooBig.join('; ') + '.');
  var counts = {};
  ['cards', 'topics', 'camps', 'themes', 'docs', 'classes', 'visits'].forEach(function (c) { counts[c] = board[c].length; });
  counts.months = Object.keys(board.mix).length; counts.pillars = board.pillars.length; counts.personas = board.personas.length; counts.people = board.people.length;

  // 4. back up and clear the current store (replace only)
  var stamp = Utilities.formatDate(new Date(nowMs_()), TB_TZ, 'yyyy-MM-dd HHmm'), backup = '';
  if (data.items.length) {
    backup = 'Board store backup ' + stamp;
    var bs = ss_open_().insertSheet(backup);
    var grid = [HEADER].concat(data.items.map(function (it) { return [it.c, it.id, it.json, it.at, it.by]; }));
    bs.getRange(1, 1, grid.length, 5).setNumberFormat('@');
    bs.getRange(1, 1, grid.length, 5).setValues(grid);
    sh.getRange(2, 1, Math.max(1, data.last - 1), 5).clearContent();
  }
  // 5. write the store
  var rows = items.length;
  if (rows + 1 > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), Math.ceil((rows + 1) * 1.3) - sh.getMaxRows());
  var nowSerial = tb_dtSerial_(tb_nowText_(nowMs_())), by = im_who_();
  if (rows) {
    var range = sh.getRange(2, 1, rows, 5);
    range.setNumberFormats(items.map(function () { return ['@', '@', '@', 'yyyy-mm-dd hh:mm:ss', '@']; }));
    range.setValues(items.map(function (r) { return [r[0], r[1], r[2], nowSerial, by]; }));
  }
  setRev_(Number(prop_('BOARD_REV', '0')) + 1);
  PropertiesService.getScriptProperties().deleteProperty('SYNC_DIRTY'); // the tables already hold this data
  CacheService.getScriptCache().remove('lists');

  Logger.log('IMPORT DONE: ' + rows + ' store rows. ' + JSON.stringify(counts) + (backup ? ' Previous store saved in the tab "' + backup + '".' : ''));
  if (warnings.length) { Logger.log(warnings.length + ' note(s) about values that could not be translated or were odd:'); warnings.slice(0, 60).forEach(function (w) { Logger.log('  - ' + w); }); }
  else Logger.log('No values needed translating by hand.');
  return { rows: rows, counts: counts, warnings: warnings, backup: backup };
}
