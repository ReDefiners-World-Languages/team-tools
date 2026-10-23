// Admin sheet: the one editable configuration (collections, picker steps, lists)
// plus the upload log. Run setup() once from the Apps Script editor.

var SHEETS = {
  collections: { name: 'Collections', headers: ['Collection ID', 'Label', 'Root Folder ID', 'Path', 'Context Fields', 'Active'] },
  steps: { name: 'Steps', headers: ['Collection ID', 'Step ID', 'Label', 'Depends On', 'Other Folder', 'Ask Note When Other', 'Order'] },
  options: { name: 'Options', headers: ['Collection ID', 'Step ID', 'Parent Value', 'Value'] },
  log: {
    name: 'Upload Log',
    headers: ['Logged At', 'Collection', 'Folder Path', 'Original Name', 'Saved As', 'File ID', 'Size (MB)', 'Type',
      'What Happened', 'Class or Event Date', 'Instructor or Staff', 'Notes', 'Placement Note', 'Uploader Name', 'Uploader Email']
  }
};

/**
 * Creates the admin sheet (first run) and fills empty tabs from DEFAULTS. Safe to run again.
 * Before the first run, set the script property CLASSES_ROOT_FOLDER_ID.
 */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('ADMIN_SHEET_ID');
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.create('ReDefiners Media Library Admin');
  props.setProperty('ADMIN_SHEET_ID', ss.getId());
  if (!props.getProperty('STAFF_DOMAIN')) props.setProperty('STAFF_DOMAIN', 'redefinerswl.org');
  if (!props.getProperty('ALLOWED_ORIGINS')) props.setProperty('ALLOWED_ORIGINS', 'https://redefiners-world-languages.github.io');
  if (!props.getProperty('MAX_FILE_GB')) props.setProperty('MAX_FILE_GB', '10');

  Object.keys(SHEETS).forEach(function (key) {
    var spec = SHEETS[key];
    var sh = ss.getSheetByName(spec.name) || ss.insertSheet(spec.name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(spec.headers);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, spec.headers.length).setFontWeight('bold');
    }
  });
  var first = ss.getSheetByName('Sheet1');
  if (first && ss.getSheets().length > 1 && first.getLastRow() === 0) ss.deleteSheet(first);

  seedFromDefaults_(ss);
  refreshConfig();
  Logger.log('Admin sheet: ' + ss.getUrl());
}

function seedFromDefaults_(ss) {
  var cols = ss.getSheetByName(SHEETS.collections.name);
  if (cols.getLastRow() > 1) return; // already configured: never overwrite edits
  var steps = ss.getSheetByName(SHEETS.steps.name);
  var opts = ss.getSheetByName(SHEETS.options.name);
  DEFAULTS.collections.forEach(function (c) {
    var rootId = prop_(c.rootFolderProperty, '');
    if (!rootId) throw new Error('Set the script property ' + c.rootFolderProperty + ' to the Drive folder id of "' + c.label + '", then run setup() again.');
    DriveApp.getFolderById(rootId); // fails here, not on the first upload, if the id is wrong
    cols.appendRow([c.id, c.label, rootId, c.path, c.contextFields.join(', '), c.active ? 'Yes' : 'No']);
    var stepRows = c.steps.map(function (s, i) {
      return [c.id, s.id, s.label, s.dependsOn, s.otherFolder, s.askNote ? 'Yes' : 'No', i + 1];
    });
    steps.getRange(steps.getLastRow() + 1, 1, stepRows.length, stepRows[0].length).setValues(stepRows);
    var optRows = [];
    Object.keys(c.options).forEach(function (stepId) {
      Object.keys(c.options[stepId]).forEach(function (parent) {
        c.options[stepId][parent].forEach(function (value) { optRows.push([c.id, stepId, parent, value]); });
      });
    });
    // Plain text so names like "(9-13)" or "10" are never turned into numbers or dates.
    var range = opts.getRange(opts.getLastRow() + 1, 1, optRows.length, 4);
    range.setNumberFormat('@').setValues(optRows);
  });
}

/** Clears the cached configuration so sheet edits show up at once (otherwise within 5 minutes). */
function refreshConfig() {
  CacheService.getScriptCache().remove('config');
}

/** Reads the admin sheet into { collections: [...] } with the same shape as DEFAULTS. */
function readConfigFromSheet_() {
  var ss = SpreadsheetApp.openById(prop_('ADMIN_SHEET_ID', ''));
  var cols = sheetRows_(ss, SHEETS.collections.name);
  var steps = sheetRows_(ss, SHEETS.steps.name);
  var opts = sheetRows_(ss, SHEETS.options.name);
  var out = { collections: [] };
  cols.forEach(function (c) {
    if (!isYes_(c['Active'])) return;
    var id = clean_(c['Collection ID']);
    var col = {
      id: id,
      label: clean_(c['Label']),
      rootFolderId: clean_(c['Root Folder ID']),
      path: clean_(c['Path']),
      contextFields: clean_(c['Context Fields']).split(',').map(clean_).filter(String),
      active: true,
      steps: [],
      options: {}
    };
    steps.filter(function (s) { return clean_(s['Collection ID']) === id; })
      .sort(function (a, b) { return Number(a['Order']) - Number(b['Order']); })
      .forEach(function (s) {
        var stepId = clean_(s['Step ID']);
        col.steps.push({
          id: stepId,
          label: clean_(s['Label']),
          dependsOn: clean_(s['Depends On']),
          otherFolder: clean_(s['Other Folder']),
          askNote: isYes_(s['Ask Note When Other'])
        });
        col.options[stepId] = {};
      });
    opts.filter(function (o) { return clean_(o['Collection ID']) === id; }).forEach(function (o) {
      var stepId = clean_(o['Step ID']);
      var value = clean_(o['Value']);
      if (!col.options[stepId] || !value) return;
      var parent = clean_(o['Parent Value']);
      (col.options[stepId][parent] = col.options[stepId][parent] || []).push(value);
    });
    out.collections.push(col);
  });
  return out;
}

/**
 * Admin check: lists MCP sites in the sheet whose place name is not on
 * redefinerswl.org/learn-in-florida any more. It cannot add new sites by itself
 * (the page is not a list); add those as rows in Options. GEP sites come from
 * Salesforce and are updated by hand (or ask Ringo to re-read the cohorts).
 */
function checkMcpSites() {
  var html = UrlFetchApp.fetch('https://redefinerswl.org/learn-in-florida', { muteHttpExceptions: true }).getContentText();
  var text = norm_(html.replace(/<[^>]+>/g, ' '));
  var col = loadConfig_().collections.filter(function (c) { return c.id === 'classes'; })[0];
  var missing = (col.options.site.MCP || []).filter(function (site) {
    var place = site.replace(/^(CBFRC|BGC)\s+/, '');
    return text.indexOf(norm_(place)) < 0;
  });
  Logger.log(missing.length ? 'Not found on the page: ' + missing.join('; ') : 'All MCP sites in the sheet appear on the page.');
}

function sheetRows_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
  var headers = values.shift();
  return values.map(function (row) {
    var o = {};
    headers.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  });
}

function isYes_(v) { return /^(yes|y|true|1)$/i.test(clean_(v)); }
function clean_(v) { return String(v == null ? '' : v).trim(); }
function norm_(s) { return s.replace(/[‘’ʼ`]/g, "'").replace(/&#39;|&rsquo;|&#x27;/g, "'").replace(/\s+/g, ' ').toLowerCase(); }
