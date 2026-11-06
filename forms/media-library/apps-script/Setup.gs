// Admin sheet: the one editable configuration (collections, picker steps, lists)
// plus the upload log. Run setup() once from the Apps Script editor.

var SHEETS = {
  // Columns after 'Active', 'Order' and 'Value' were added for the Events, People and Campaigns sections
  // (2026-11). upgradeSheets() adds them to an existing sheet; blank cells keep the old behavior.
  collections: { name: 'Collections', headers: ['Collection ID', 'Label', 'Root Folder ID', 'Path', 'Context Fields', 'Active', 'Date Label', 'Optional Fields'] },
  steps: { name: 'Steps', headers: ['Collection ID', 'Step ID', 'Label', 'Depends On', 'Other Folder', 'Ask Note When Other', 'Order', 'Input', 'Allow New', 'None Label', 'Max Length'] },
  options: { name: 'Options', headers: ['Collection ID', 'Step ID', 'Parent Value', 'Value', 'Hint', 'Added By', 'Added At'] },
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
  upgradeSheets_(ss);
  var first = ss.getSheetByName('Sheet1');
  if (first && ss.getSheets().length > 1 && first.getLastRow() === 0) ss.deleteSheet(first);

  seedFromDefaults_(ss);
  refreshConfig();
  Logger.log('Admin sheet: ' + ss.getUrl());
}

function seedFromDefaults_(ss) {
  var cols = ss.getSheetByName(SHEETS.collections.name);
  if (cols.getLastRow() > 1) return; // already configured: never overwrite edits
  DEFAULTS.collections.forEach(function (c) { appendCollection_(ss, c, c.active); });
}

/**
 * Adds to the columns of an existing admin sheet the headers that are missing (at the end of
 * each tab). Never moves, clears or rewrites anything. Safe to run again.
 */
function upgradeSheets() {
  var ss = SpreadsheetApp.openById(prop_('ADMIN_SHEET_ID', ''));
  upgradeSheets_(ss);
  refreshConfig();
}

function upgradeSheets_(ss) {
  Object.keys(SHEETS).forEach(function (key) {
    var spec = SHEETS[key];
    var sh = ss.getSheetByName(spec.name);
    if (!sh || sh.getLastRow() === 0) return;
    var have = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0].map(clean_);
    spec.headers.filter(function (h) { return have.indexOf(h) < 0; }).forEach(function (h) {
      var c = sh.getLastColumn() + 1;
      sh.getRange(1, c).setValue(h).setFontWeight('bold');
    });
  });
}

/**
 * Appends the collections from Defaults.gs that the sheet does not have yet (Events, People,
 * Campaigns), switched OFF (Active = No): switch each one on in the sheet once the page that can
 * draw it is live. Needs the script property named in rootFolderProperty for each one.
 * Never touches rows that are already there.
 */
function addNewCollections() {
  var ss = SpreadsheetApp.openById(prop_('ADMIN_SHEET_ID', ''));
  upgradeSheets_(ss);
  var have = sheetRows_(ss, SHEETS.collections.name).map(function (r) { return clean_(r['Collection ID']); });
  var added = [];
  DEFAULTS.collections.forEach(function (c) {
    if (have.indexOf(c.id) >= 0) return;
    appendCollection_(ss, c, false);
    added.push(c.label);
  });
  refreshConfig();
  Logger.log(added.length ? 'Added (Active = No): ' + added.join(', ') : 'Nothing to add.');
}

/** Writes one collection's rows by header name, so column order in the sheet does not matter. */
function appendCollection_(ss, c, active) {
  var rootId = prop_(c.rootFolderProperty, '');
  if (!rootId) throw new Error('Set the script property ' + c.rootFolderProperty + ' to the Drive folder id of "' + c.label + '", then run this again.');
  DriveApp.getFolderById(rootId); // fails here, not on the first upload, if the id is wrong
  appendRows_(ss, SHEETS.collections.name, [{
    'Collection ID': c.id, 'Label': c.label, 'Root Folder ID': rootId, 'Path': c.path,
    'Context Fields': c.contextFields.join(', '), 'Active': active ? 'Yes' : 'No',
    'Date Label': c.dateLabel || '', 'Optional Fields': (c.optionalFields || []).join(', ')
  }]);
  appendRows_(ss, SHEETS.steps.name, c.steps.map(function (st, i) {
    return {
      'Collection ID': c.id, 'Step ID': st.id, 'Label': st.label, 'Depends On': st.dependsOn || '',
      'Other Folder': st.otherFolder || '', 'Ask Note When Other': st.askNote ? 'Yes' : 'No', 'Order': i + 1,
      'Input': st.input === 'text' ? 'Text' : 'List', 'Allow New': st.allowNew ? 'Yes' : 'No',
      'None Label': st.noneLabel || '', 'Max Length': st.maxLength || ''
    };
  }));
  var optRows = [];
  Object.keys(c.options).forEach(function (stepId) {
    var st = c.steps.filter(function (x) { return x.id === stepId; })[0] || {};
    Object.keys(c.options[stepId]).forEach(function (parent) {
      c.options[stepId][parent].forEach(function (value) {
        optRows.push({ 'Collection ID': c.id, 'Step ID': stepId, 'Parent Value': parent, 'Value': value, 'Hint': (st.hints || {})[parent] || '' });
      });
    });
  });
  appendRows_(ss, SHEETS.options.name, optRows);
}

/**
 * Appends rows given as { header: value }. Every cell is plain text, so names like "(9-13)" or
 * "10" never turn into numbers or dates. Caller holds the script lock when staff can write too.
 */
function appendRows_(ss, tabName, objects) {
  if (!objects.length) return;
  var sh = ss.getSheetByName(tabName);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0].map(clean_);
  var rows = objects.map(function (o) {
    return headers.map(function (h) { return o.hasOwnProperty(h) && o[h] != null ? String(o[h]) : ''; });
  });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, headers.length).setNumberFormat('@').setValues(rows);
}

/**
 * Admin helper: lists the subfolders of every campaign folder in Drive and adds the missing ones
 * to Options as sub-campaigns (year folders like "2026" are skipped). Adds only; never removes.
 */
function syncCampaignSubfolders() { syncSubfolders('campaigns', 'subcampaign'); }

function syncSubfolders(collectionId, stepId) {
  var col = loadConfig_().collections.filter(function (c) { return c.id === collectionId; })[0];
  if (!col) {
    // Also works while the collection is still switched off.
    var row = sheetRows_(SpreadsheetApp.openById(prop_('ADMIN_SHEET_ID', '')), SHEETS.collections.name)
      .filter(function (r) { return clean_(r['Collection ID']) === collectionId; })[0];
    if (!row) throw new Error('No collection ' + collectionId + ' in the sheet.');
    col = { id: collectionId, rootFolderId: clean_(row['Root Folder ID']), options: {} };
  }
  var known = (col.options && col.options[stepId]) || {};
  var rows = [];
  var parents = DriveApp.getFolderById(col.rootFolderId).getFolders();
  while (parents.hasNext()) {
    var parent = parents.next();
    var subs = parent.getFolders();
    while (subs.hasNext()) {
      var name = subs.next().getName();
      if (/^\d{4}$/.test(name)) continue; // a year folder, not a sub-campaign
      if ((known[parent.getName()] || []).indexOf(name) >= 0) continue;
      rows.push({ 'Collection ID': collectionId, 'Step ID': stepId, 'Parent Value': parent.getName(), 'Value': name });
    }
  }
  appendRows_(SpreadsheetApp.openById(prop_('ADMIN_SHEET_ID', '')), SHEETS.options.name, rows);
  refreshConfig();
  Logger.log(rows.length ? 'Added: ' + rows.map(function (r) { return r['Parent Value'] + '/' + r['Value']; }).join('; ') : 'Nothing new.');
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
      optionalFields: clean_(c['Optional Fields']).split(',').map(clean_).filter(String),
      dateLabel: clean_(c['Date Label']),
      active: true,
      steps: [],
      options: {}
    };
    steps.filter(function (s) { return clean_(s['Collection ID']) === id; })
      .sort(function (a, b) { return Number(a['Order']) - Number(b['Order']); })
      .forEach(function (s) {
        var stepId = clean_(s['Step ID']);
        if (/^(year|month|date|type|mlCollection|mlToken|mlLogged|eventDate)$/.test(stepId)) {
          throw new Error('Step ID "' + stepId + '" in ' + id + ' is a reserved name. Rename it in the Steps tab (and Options).');
        }
        col.steps.push({
          id: stepId,
          label: clean_(s['Label']),
          dependsOn: clean_(s['Depends On']),
          otherFolder: clean_(s['Other Folder']),
          askNote: isYes_(s['Ask Note When Other']),
          input: /^text$/i.test(clean_(s['Input'])) ? 'text' : 'list',
          allowNew: isYes_(s['Allow New']),
          noneLabel: clean_(s['None Label']),
          maxLength: Number(clean_(s['Max Length'])) || 0,
          hints: {}
        });
        col.options[stepId] = {};
      });
    opts.filter(function (o) { return clean_(o['Collection ID']) === id; }).forEach(function (o) {
      var stepId = clean_(o['Step ID']);
      var value = clean_(o['Value']);
      if (!col.options[stepId] || !value) return;
      var parent = clean_(o['Parent Value']);
      var list = (col.options[stepId][parent] = col.options[stepId][parent] || []);
      if (list.indexOf(value) < 0) list.push(value);
      var hint = clean_(o['Hint']);
      if (hint) col.steps.filter(function (st) { return st.id === stepId; })[0].hints[parent] = hint;
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
