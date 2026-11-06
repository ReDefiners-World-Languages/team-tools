// ReDefiners Media Library API (Apps Script web app, runs as the Drive owner).
// Every action needs a Google ID token from an @STAFF_DOMAIN account (Sign in with Google on the page).
// The uploader's name and email come from that sign-in, never from what the page sends.
// The page never receives a Drive access token. For uploads it gets a resumable
// session URL for one file and sends the bytes straight to Drive.
// Nothing here deletes, overwrites, renames or shares a file or folder.

var DRIVE = 'https://www.googleapis.com/drive/v3';
var TZ = 'America/New_York';
var FIRST_CLASS_DATE = '2016-01-01'; // ReDefiners was founded in 2016
var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
var MEDIA_EXT = /\.(jpe?g|png|gif|webp|heic|heif|tiff?|bmp|dng|cr2|cr3|nef|arw|raf|orf|rw2|mp4|mov|m4v|avi|mkv|webm|3gp|3g2|mts|m2ts|wmv|mpg|mpeg)$/i;
var FIELD_LIMITS = { what: 200, date: 10, staff: 120, notes: 1500, otherNote: 300 };
var FILE_FIELDS = 'id,name,mimeType,size,createdTime,hasThumbnail,description,properties,parents,webViewLink';
var NAME_MAX = 60;                // typed folder names (event, person, moment, new campaign)
var NAME_BAD = /[\/\\<>:"|?*]/; // break paths, downloads or zip files on Windows

var STAFF_ACTIONS = {
  whoami: function (req, who) { return who; },
  start: function (req, who) { return { who: who, config: getPublicConfig_() }; }, // one round trip after sign-in
  config: getPublicConfig_, startUpload: startUpload_, finishUpload: finishUpload_,
  search: search_, browse: browse_, thumbnail: thumbnail_, thumbnails: thumbnails_,
  existingFolders: existingFolders_
};

function doGet() {
  return json_({ ok: true, service: 'ReDefiners Media Library API' });
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
    if (STAFF_ACTIONS.hasOwnProperty(action)) {
      var who = verifyStaff_(req.idToken);
      return json_({ ok: true, data: STAFF_ACTIONS[action](req, who) });
    }
    throw userError_('bad_request', 'Unknown action.');
  } catch (err) {
    if (err.userCode) return json_({ ok: false, error: err.userCode, message: err.message });
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, error: 'server_error', message: 'Something went wrong on our side. Try again in a minute.' });
  }
}

// ---------- configuration ----------

function loadConfig_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('config');
  if (hit) return JSON.parse(hit);
  var config = readConfigFromSheet_();
  cache.put('config', JSON.stringify(config), 300);
  return config;
}

function collection_(id) {
  var col = loadConfig_().collections.filter(function (c) { return c.id === id; })[0];
  if (!col) throw userError_('bad_choice', 'That destination is not available.');
  return col;
}

/** What the page needs to draw the pickers. No folder ids. */
function getPublicConfig_() {
  return {
    staffDomain: prop_('STAFF_DOMAIN', 'redefinerswl.org'),
    maxFileGb: Number(prop_('MAX_FILE_GB', '10')),
    collections: loadConfig_().collections.map(function (c) {
      var known = {};
      c.steps.forEach(function (st) { if (st.allowNew && !st.dependsOn) known[st.id] = knownFolders_(c); });
      return { id: c.id, label: c.label, path: c.path, contextFields: c.contextFields, optionalFields: c.optionalFields || [],
        dateLabel: c.dateLabel || '', steps: c.steps, options: c.options, known: known };
    })
  };
}

/**
 * Checks every choice against the lists and returns the folder segments.
 * Other is allowed only on steps with an Other Folder; a step that has no list
 * for the chosen parent does not apply and must be empty.
 */
/**
 * The year and month folders: the class date when the collection asks for one
 * (Lucas Blanco, 2026-10-23), otherwise the upload date.
 */
function folderDate_(col, context, now) {
  if (col.contextFields.indexOf('date') < 0) {
    return { year: Utilities.formatDate(now, TZ, 'yyyy'), mm: Utilities.formatDate(now, TZ, 'MM') };
  }
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(context.date || '');
  var tomorrow = Utilities.formatDate(new Date(now.getTime() + 864e5), TZ, 'yyyy-MM-dd');
  if (!m || context.date < FIRST_CLASS_DATE || context.date > tomorrow || Number(m[2]) < 1 || Number(m[2]) > 12) {
    throw userError_('bad_context', 'Pick the ' + (col.dateLabel || 'date of the class').replace(/^Date/, 'date') + '.');
  }
  return { year: m[1], mm: m[2], iso: context.date };
}

function monthFolder_(year, mm) {
  return mm + ' ' + MONTH_NAMES[Number(mm) - 1] + ' ' + year;
}

function resolveDestination_(col, choices, when, confirmNew) {
  choices = choices || {};
  confirmNew = confirmNew || {};
  var chosen = {};
  var folders = {};
  var loose = {};     // typed values: matched to existing folders ignoring case and spacing
  var created = [];   // { step, name }: new list values (a new campaign) to add to Options after the upload starts
  col.steps.forEach(function (st) {
    var list = stepList_(col, st, chosen);
    var value = clean_(choices[st.id]);
    if (!list.length) {
      if (value) throw userError_('bad_choice', st.label + ' does not apply to this choice.');
      return;
    }
    if (st.input === 'text') {
      var name = cleanName_(value, st, list[0]);
      chosen[st.id] = folders[st.id] = name;
      loose[st.id] = true;
      return;
    }
    if (!value) throw userError_('bad_choice', 'Pick a ' + st.label.toLowerCase() + '.');
    if (value === OTHER) {
      if (!st.otherFolder) throw userError_('bad_choice', 'Pick a ' + st.label.toLowerCase() + ' from the list.');
      chosen[st.id] = OTHER;
      folders[st.id] = st.otherFolder;
      return;
    }
    if (value === NONE) {
      if (!st.noneLabel) throw userError_('bad_choice', 'Pick a ' + st.label.toLowerCase() + ' from the list.');
      chosen[st.id] = NONE; // no folder: the step drops out of the path
      return;
    }
    var hit = list.indexOf(value) >= 0 ? value : (st.allowNew ? looseFind_(list, value) : '');
    if (!hit && st.allowNew && !st.dependsOn) hit = looseFind_(knownFolders_(col), value); // a folder that is not offered
    if (hit) {
      chosen[st.id] = folders[st.id] = hit;
      return;
    }
    if (!st.allowNew) throw userError_('bad_choice', 'Pick a ' + st.label.toLowerCase() + ' from the list.');
    var fresh = cleanName_(value, st, st.label);
    if (norm_(clean_(confirmNew[st.id])) !== norm_(fresh)) {
      throw userError_('confirm_new', 'Confirm that you want a new ' + st.label.toLowerCase() + ' folder named "' + fresh + '".');
    }
    chosen[st.id] = folders[st.id] = fresh;
    loose[st.id] = true;
    created.push({ step: st, name: fresh });
  });
  folders.year = when.year;
  folders.month = monthFolder_(when.year, when.mm);
  folders.date = when.iso || '';
  var built = buildSegments_(col.path, folders, true);
  return {
    chosen: chosen, segments: built.names, keys: built.keys, parts: built.parts,
    loose: built.keys.map(function (keys) { return keys.some(function (k) { return loose[k]; }); }),
    created: created, year: when.year, month: when.mm
  };
}

/** The allowed values of a step for the choices made so far ([] = the step does not apply). */
function stepList_(col, st, chosen) {
  if (!st.dependsOn) return (col.options[st.id] || {})[''] || [];
  var parent = chosen[st.dependsOn];
  return parent && parent !== OTHER && parent !== NONE ? ((col.options[st.id] || {})[parent] || []) : [];
}

/** A typed name made safe for a folder name, or a clear refusal. */
function cleanName_(raw, st, label) {
  var v = clean_(raw).replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ');
  var max = st.maxLength || NAME_MAX;
  if (!v) throw userError_('bad_choice', 'Type the ' + label.charAt(0).toLowerCase() + label.slice(1) + '.');
  if (v.length > max) throw userError_('bad_choice', label + ' is longer than ' + max + ' characters.');
  if (NAME_BAD.test(v)) throw userError_('bad_choice', label + ' cannot contain / \\ < > : " | ? or *.');
  if (/^\./.test(v)) throw userError_('bad_choice', label + ' cannot start with a dot.');
  return v;
}

/** The entry of list that matches value ignoring case, spacing and curly quotes, or ''. */
function looseFind_(list, value) {
  var n = norm_(value);
  return list.filter(function (x) { return norm_(x) === n; })[0] || '';
}

/** Names of the folders directly in a collection's root (for "add a new one" steps). Cached 5 minutes. */
function knownFolders_(col) {
  var cache = CacheService.getScriptCache();
  var key = 'known:' + col.id;
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var names = childFolders_(col.rootFolderId).map(function (f) { return f.name; });
  cache.put(key, JSON.stringify(names), 300);
  return names;
}

function childFolders_(parentId) {
  var out = [], token = '';
  do {
    var params = { q: "'" + parentId + "' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      fields: 'nextPageToken,files(id,name)', pageSize: 1000 };
    if (token) params.pageToken = token;
    var res = driveGet_('/files', params);
    out = out.concat(res.files || []);
    token = res.nextPageToken || '';
  } while (token);
  return out;
}

/**
 * Template to folder names. A folder made of several tokens ("{date} - {name}") is kept only
 * when every token has a value; strict mode refuses a half-filled one, display mode drops it.
 * One-token folders behave as before: empty means the step does not apply and it drops out.
 */
function buildSegments_(template, folders, strict) {
  var names = [], keys = [], parts = [];
  template.split('/').forEach(function (part) {
    var tokens = (part.match(/\{(\w+)\}/g) || []).map(function (t) { return t.slice(1, -1); });
    var filled = tokens.filter(function (k) { return folders[k]; });
    if (tokens.length && filled.length < tokens.length) {
      if (filled.length && strict) throw userError_('bad_choice', 'Something is missing for the folder ' + part + '.');
      return;
    }
    var name = part.replace(/\{(\w+)\}/g, function (m, key) { return folders[key]; }).trim();
    if (!name) return;
    names.push(name); keys.push(tokens); parts.push(part);
  });
  return { names: names, keys: keys, parts: parts };
}

function segmentsFromTemplate_(template, folders) {
  return buildSegments_(template, folders, false).names;
}

/** Reads the token values back out of a folder name made from a template part. */
function tokensFromName_(part, name) {
  var keys = [];
  var re = new RegExp('^' + part.split(/(\{\w+\})/).map(function (bit) {
    var m = /^\{(\w+)\}$/.exec(bit);
    if (m) { keys.push(m[1]); return '(.+?)'; }
    return bit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('') + '$');
  var m = re.exec(name);
  var out = {};
  if (m) keys.forEach(function (k, i) { out[k] = m[i + 1]; });
  return out;
}

// ---------- upload ----------

function startUpload_(req, who) {
  var col = collection_(req.collection);
  var file = req.file || {};
  var name = clean_(file.name).replace(/[\/\\]/g, '_');
  var size = Number(file.size);
  if (!name) throw userError_('bad_file', 'A file has no name.');
  if (!(size > 0)) throw userError_('bad_file', name + ' is empty.');
  var maxGb = Number(prop_('MAX_FILE_GB', '10'));
  if (size > maxGb * 1024 * 1024 * 1024) throw userError_('bad_file', name + ' is larger than ' + maxGb + ' GB.');
  var mime = clean_(file.type).toLowerCase();
  if (!/^(image|video)\//.test(mime)) {
    if (!MEDIA_EXT.test(name)) throw userError_('bad_file', name + ' is not a photo or video.');
    mime = 'application/octet-stream';
  }
  var origin = clean_(req.origin);
  var allowed = prop_('ALLOWED_ORIGINS', '').split(',').map(clean_);
  if (allowed.indexOf(origin) < 0) throw userError_('bad_origin', 'Uploads are not allowed from this address.');

  var context = cleanContext_(req.context, col, who);
  if (requiredFields_(col).indexOf('what') >= 0 && !context.what) throw userError_('bad_context', 'Say what happened (class, event or activity).');

  var dest = resolveDestination_(col, req.choices, folderDate_(col, context, new Date()), req.confirmNew);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var folder, savedAs;
  try {
    var made = ensureFolders_(col.rootFolderId, dest.segments, dest.loose);
    folder = made.folder;
    adoptExistingNames_(dest, made.names);
    savedAs = uniqueName_(folder.id, name);
    dest.created.forEach(function (c) { addOption_(col, c.step, '', dest.chosen[c.step.id], who); });
  } finally {
    lock.releaseLock();
  }

  var token = Utilities.getUuid();
  var properties = { mlCollection: col.id, mlToken: token, year: dest.year, month: dest.month,
    type: /^video\//.test(mime) || /\.(mp4|mov|m4v|avi|mkv|webm|3gp|3g2|mts|m2ts|wmv|mpg|mpeg)$/i.test(name) ? 'video' : 'photo' };
  if (context.date) properties.eventDate = context.date;
  Object.keys(dest.chosen).forEach(function (k) {
    if (dest.chosen[k] === NONE) return;
    properties[k] = dest.chosen[k] === OTHER ? 'Other' : dest.chosen[k];
  });
  checkPropertySizes_(properties);

  var path = dest.segments.join('/');
  var meta = { name: savedAs, parents: [folder.id], description: describe_(context, col.label + '/' + path, col), properties: properties };
  var res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify(meta),
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Type': mime,
      'X-Upload-Content-Length': String(size),
      Origin: origin // lets the browser send the bytes to this session (CORS)
    },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    console.error('Resumable session failed: ' + res.getResponseCode() + ' ' + res.getContentText());
    throw userError_('drive_error', 'Google Drive did not accept the upload. Try again in a minute.');
  }
  var headers = res.getAllHeaders();
  var uploadUrl = headers.Location || headers.location;
  return { uploadUrl: uploadUrl, token: token, savedAs: savedAs, path: col.label + '/' + path };
}

function requiredFields_(col) {
  return col.contextFields.filter(function (f) { return (col.optionalFields || []).indexOf(f) < 0; });
}

/**
 * When a typed name matched a folder that already exists with other capitals or spacing, use the
 * existing folder's exact name everywhere (path, properties, new Options row).
 */
function adoptExistingNames_(dest, actual) {
  actual.forEach(function (name, i) {
    if (name === dest.segments[i]) return;
    dest.segments[i] = name;
    var values = tokensFromName_(dest.parts[i], name);
    dest.keys[i].forEach(function (k) {
      if (values[k] && dest.chosen[k] && dest.chosen[k] !== OTHER && dest.chosen[k] !== NONE) dest.chosen[k] = values[k];
    });
  });
  // A "new" value whose folder turned out to exist already is not new.
  dest.created = dest.created.filter(function (c) { return c.name === dest.chosen[c.step.id]; });
}

/** Adds a value to Options (a new campaign) unless it is already there. Caller holds the lock. */
function addOption_(col, st, parent, value, who) {
  var ss = SpreadsheetApp.openById(prop_('ADMIN_SHEET_ID', ''));
  var have = sheetRows_(ss, SHEETS.options.name).some(function (o) {
    return clean_(o['Collection ID']) === col.id && clean_(o['Step ID']) === st.id &&
      clean_(o['Parent Value']) === parent && norm_(clean_(o['Value'])) === norm_(value);
  });
  if (!have) {
    appendRows_(ss, SHEETS.options.name, [{ 'Collection ID': col.id, 'Step ID': st.id, 'Parent Value': parent, 'Value': value,
      'Added By': who && who.email ? who.email : '', 'Added At': Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm') }]);
  }
  refreshConfig();
  CacheService.getScriptCache().remove('known:' + col.id);
}

/**
 * Read-only: the folders that already exist for the chosen type and date, so staff can join an
 * existing event folder instead of typing a near-duplicate. Returns the typed-name part only.
 */
function existingFolders_(req) {
  var col = collection_(req.collection);
  var st = col.steps.filter(function (x) { return x.id === req.step && x.input === 'text'; })[0];
  if (!st) throw userError_('bad_request', 'That field has no folders to list.');
  var choices = {};
  Object.keys(req.choices || {}).forEach(function (k) { choices[k] = req.choices[k]; });
  choices[st.id] = 'x'; // placeholder, only the folders above it are looked up
  var when = folderDate_(col, { date: clean_(req.date) }, new Date());
  var dest = resolveDestination_(col, choices, when, {});
  var at = -1;
  dest.keys.forEach(function (keys, i) { if (at < 0 && keys.indexOf(st.id) >= 0) at = i; });
  if (at < 0) return { names: [] };
  var parentId = findFolders_(col.rootFolderId, dest.segments.slice(0, at));
  if (!parentId) return { names: [] };
  var wanted = tokensFromName_(dest.parts[at], dest.segments[at]); // the other values in that folder name (the date)
  var names = [];
  childFolders_(parentId).forEach(function (f) {
    var values = tokensFromName_(dest.parts[at], f.name);
    if (!values[st.id]) return;
    var same = dest.keys[at].every(function (k) { return k === st.id || values[k] === wanted[k]; });
    if (same) names.push(values[st.id]);
  });
  return { names: names.sort() };
}

/** Folder id for a trail of names, or '' when any of them is missing. Never creates anything. */
function findFolders_(rootId, segments) {
  var parentId = rootId;
  for (var i = 0; i < segments.length; i++) {
    var q = "'" + parentId + "' in parents and name = '" + q_(segments[i]) + "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
    var found = driveGet_('/files', { q: q, fields: 'files(id)', pageSize: 1 }).files || [];
    if (!found.length) return '';
    parentId = found[0].id;
  }
  return parentId;
}

/** Called after Drive confirms the file. Checks it is ours, then writes the log row once. */
function finishUpload_(req, who) {
  var col = collection_(req.collection);
  var fileId = clean_(req.fileId);
  if (!/^[\w-]{10,}$/.test(fileId)) throw userError_('bad_request', 'Missing file id.');
  var f = driveGet_('/files/' + fileId, { fields: 'id,name,mimeType,size,parents,properties' });
  var p = f.properties || {};
  if (p.mlCollection !== col.id || p.mlToken !== clean_(req.token)) throw userError_('bad_request', 'That upload could not be matched.');
  if (p.mlLogged) return { logged: true };

  var context = cleanContext_(req.context, col, who);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var again = driveGet_('/files/' + fileId, { fields: 'properties' }).properties || {};
    if (again.mlLogged) return { logged: true };
    var ss = SpreadsheetApp.openById(prop_('ADMIN_SHEET_ID', ''));
    var row = [new Date(), col.label, pathFromProperties_(col, p), clean_(req.originalName).slice(0, 300), f.name, f.id,
      Math.round(Number(f.size || 0) / 10485.76) / 100, p.type || '', context.what, context.date, context.staff, context.notes,
      context.otherNote, context.uploaderName, context.uploaderEmail];
    // Plain text: stops a typed "=..." from running as a formula in the sheet.
    var sh = ss.getSheetByName(SHEETS.log.name);
    sh.getRange(sh.getLastRow() + 1, 1, 1, row.length).setNumberFormats([row.map(function (v, i) { return i === 0 ? 'yyyy-mm-dd hh:mm' : (i === 6 ? '0.00' : '@'); })]).setValues([row]);
    drivePatch_('/files/' + fileId, { properties: { mlLogged: '1' } });
  } finally {
    lock.releaseLock();
  }
  return { logged: true };
}

function cleanContext_(raw, col, who) {
  raw = raw || {};
  var out = {};
  Object.keys(FIELD_LIMITS).forEach(function (k) {
    var allowed = col.contextFields.indexOf(k) >= 0 || k === 'otherNote';
    out[k] = allowed ? clean_(raw[k]).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, FIELD_LIMITS[k]) : '';
  });
  if (out.date && !/^\d{4}-\d{2}-\d{2}$/.test(out.date)) out.date = '';
  out.uploaderName = who && who.name ? String(who.name).slice(0, 120) : '';
  out.uploaderEmail = who && who.email ? String(who.email) : '';
  return out;
}

/** The Drive description: readable, and searchable through Drive's full-text search. */
function describe_(c, folderPath, col) {
  var lines = [];
  if (c.what) lines.push('What happened: ' + c.what);
  if (c.date) lines.push((col && col.dateLabel ? col.dateLabel : 'Class or event date') + ': ' + c.date);
  if (c.staff) lines.push('Instructor or staff: ' + c.staff);
  if (c.notes) lines.push('Notes: ' + c.notes);
  if (c.otherNote) lines.push('Placement note: ' + c.otherNote);
  var by = [c.uploaderName, c.uploaderEmail ? '<' + c.uploaderEmail + '>' : ''].filter(String).join(' ');
  if (by) lines.push('Uploaded by: ' + by);
  lines.push('Folder: ' + folderPath);
  lines.push('Filed through the ReDefiners Media Library page on ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd') + '.');
  return lines.join('\n');
}

function pathFromProperties_(col, p) {
  var folders = { year: p.year || '', month: '', date: p.eventDate || '' };
  if (p.year && p.month) {
    var d = new Date(Number(p.year), Number(p.month) - 1, 15);
    folders.month = Utilities.formatDate(d, TZ, 'MM MMMM yyyy');
  }
  col.steps.forEach(function (st) {
    if (!p[st.id]) return;
    folders[st.id] = p[st.id] === 'Other' && st.otherFolder ? st.otherFolder : p[st.id];
  });
  return col.label + '/' + segmentsFromTemplate_(col.path, folders).join('/');
}

function checkPropertySizes_(props) {
  Object.keys(props).forEach(function (k) {
    if (Utilities.newBlob(k + props[k]).getBytes().length > 124) throw userError_('bad_choice', 'The name "' + props[k] + '" is too long to store.');
  });
}

/**
 * Finds each folder by exact name under its parent and creates it only when missing. Folders made
 * from typed names (loose[i]) also match an existing folder that differs only in capitals, spacing
 * or curly quotes, and then that folder's exact name is used. Caller holds the lock.
 * Returns { folder, names } (the names actually used).
 */
function ensureFolders_(rootId, segments, loose) {
  var parentId = rootId;
  var folder = { id: rootId };
  var names = [];
  segments.forEach(function (name, i) {
    var q = "'" + parentId + "' in parents and name = '" + q_(name) + "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
    var found = driveGet_('/files', { q: q, fields: 'files(id,name)', pageSize: 10 }).files || [];
    if (!found.length && loose && loose[i]) {
      found = childFolders_(parentId).filter(function (f) { return norm_(f.name) === norm_(name); });
    }
    folder = found.length ? found[0] : drivePost_('/files', { name: name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }, 'id,name');
    names.push(folder.name || name);
    parentId = folder.id;
  });
  return { folder: folder, names: names };
}

/** Original name, or "name (2).ext", "name (3).ext"... Names handed out in the last 6 hours count as taken. Caller holds the lock. */
function uniqueName_(folderId, name) {
  var cache = CacheService.getScriptCache();
  var dot = name.lastIndexOf('.');
  var base = dot > 0 ? name.slice(0, dot) : name;
  var ext = dot > 0 ? name.slice(dot) : '';
  for (var n = 1; n < 500; n++) {
    var candidate = n === 1 ? name : base + ' (' + n + ')' + ext;
    var key = 'name:' + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, folderId + '/' + candidate));
    if (cache.get(key)) continue;
    var q = "'" + folderId + "' in parents and name = '" + q_(candidate) + "' and trashed = false";
    if ((driveGet_('/files', { q: q, fields: 'files(id)', pageSize: 1 }).files || []).length) continue;
    cache.put(key, '1', 21600);
    return candidate;
  }
  throw userError_('bad_file', 'Too many files named ' + name + ' in this folder.');
}

// ---------- staff: search, browse, thumbnails ----------

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
  if (!ok) throw userError_('not_staff', 'Search and browse are for @' + domain + ' Google accounts only.');
  var who = { email: t.email, name: t.name || '' };
  cache.put(key, JSON.stringify(who), Math.max(60, Math.min(3600, Number(t.exp) - nowSec)));
  return who;
}

function search_(req) {
  var col = collection_(req.collection);
  var q = ["trashed = false", "properties has { key='mlCollection' and value='" + q_(col.id) + "' }"];
  var filters = req.filters || {};
  var keys = col.steps.map(function (s) { return s.id; }).concat(['year', 'month', 'type']);
  keys.forEach(function (k) {
    var v = clean_(filters[k]);
    if (v) q.push("properties has { key='" + k + "' and value='" + q_(v) + "' }");
  });
  var words = clean_(req.q).split(/\s+/).filter(String).slice(0, 8);
  words.forEach(function (w) { q.push("fullText contains '" + q_(w) + "'"); });
  var params = { q: q.join(' and '), fields: 'nextPageToken,files(' + FILE_FIELDS + ')', pageSize: 48 };
  if (!words.length) params.orderBy = 'createdTime desc'; // Drive does not sort full-text results
  if (req.pageToken) params.pageToken = String(req.pageToken);
  var res = driveGet_('/files', params);
  return {
    files: (res.files || []).map(function (f) { return fileOut_(f, pathFromProperties_(col, f.properties || {})); }),
    nextPageToken: res.nextPageToken || ''
  };
}

function browse_(req) {
  var col = collection_(req.collection);
  var folderId = clean_(req.folderId) || col.rootFolderId;
  var crumbs = breadcrumbs_(folderId, col);
  var params = {
    q: "'" + folderId + "' in parents and trashed = false and (mimeType = 'application/vnd.google-apps.folder' or mimeType contains 'image/' or mimeType contains 'video/')",
    fields: 'nextPageToken,files(' + FILE_FIELDS + ')',
    orderBy: 'folder,name',
    pageSize: 200
  };
  if (req.pageToken) params.pageToken = String(req.pageToken);
  var res = driveGet_('/files', params);
  var here = crumbs.map(function (c) { return c.name; }).join('/');
  var folders = [], files = [];
  (res.files || []).forEach(function (f) {
    if (f.mimeType === 'application/vnd.google-apps.folder') folders.push({ id: f.id, name: f.name });
    else files.push(fileOut_(f, here));
  });
  return { crumbs: crumbs, folders: folders, files: files, nextPageToken: res.nextPageToken || '' };
}

function thumbnail_(req) {
  var col = collection_(req.collection);
  var f = driveGet_('/files/' + clean_(req.fileId), { fields: 'id,parents,thumbnailLink,mimeType' });
  breadcrumbs_((f.parents || [])[0], col); // throws when the file is outside the collection
  if (!f.thumbnailLink) return { dataUrl: '' };
  var size = req.large ? 's1600' : 's400';
  var res = UrlFetchApp.fetch(f.thumbnailLink.replace(/=s\d+$/, '=' + size), {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return { dataUrl: '' };
  var blob = res.getBlob();
  return { dataUrl: 'data:' + (blob.getContentType() || 'image/jpeg') + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

/**
 * Up to 24 small previews in one call. Drive is asked for all of them at once (fetchAll),
 * which is much faster than one page-to-script round trip per picture.
 */
function thumbnails_(req) {
  var col = collection_(req.collection);
  var ids = (req.fileIds || []).map(clean_).filter(function (id) { return /^[\w-]{10,}$/.test(id); }).slice(0, 24);
  if (!ids.length) return { dataUrls: {} };
  var auth = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
  var metas = UrlFetchApp.fetchAll(ids.map(function (id) {
    return { url: DRIVE + '/files/' + id + '?fields=id,parents,thumbnailLink', headers: auth, muteHttpExceptions: true };
  })).map(function (res) { return res.getResponseCode() === 200 ? JSON.parse(res.getContentText()) : null; });
  var wanted = metas.filter(function (f) {
    if (!f || !f.thumbnailLink) return false;
    try { breadcrumbs_((f.parents || [])[0], col); return true; } catch (e) { return false; } // outside the library: skip
  });
  var out = {};
  var pics = UrlFetchApp.fetchAll(wanted.map(function (f) {
    return { url: f.thumbnailLink.replace(/=s\d+$/, '=s400'), headers: auth, muteHttpExceptions: true };
  }));
  pics.forEach(function (res, i) {
    if (res.getResponseCode() !== 200) return;
    var blob = res.getBlob();
    out[wanted[i].id] = 'data:' + (blob.getContentType() || 'image/jpeg') + ';base64,' + Utilities.base64Encode(blob.getBytes());
  });
  return { dataUrls: out };
}

/**
 * Root-to-folder trail. Throws when the folder is not inside the collection's root.
 * Each folder's trail is cached, so a subfolder of an open folder costs one Drive call.
 */
function breadcrumbs_(folderId, col, depth) {
  if (!folderId || (depth || 0) > 15) throw userError_('not_found', 'That folder is not in the library.');
  if (folderId === col.rootFolderId) return [{ id: folderId, name: col.label }];
  var cache = CacheService.getScriptCache();
  var key = 'crumbs:' + col.id + ':' + folderId;
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var f = driveGet_('/files/' + folderId, { fields: 'id,name,parents' });
  if (!f.parents || !f.parents.length) throw userError_('not_found', 'That folder is not in the library.');
  var trail = breadcrumbs_(f.parents[0], col, (depth || 0) + 1).concat([{ id: f.id, name: f.name }]);
  cache.put(key, JSON.stringify(trail), 3600);
  return trail;
}

function fileOut_(f, path) {
  var p = f.properties || {};
  return {
    id: f.id, name: f.name, path: path, size: Number(f.size || 0), createdTime: f.createdTime,
    kind: /^video\//.test(f.mimeType) || p.type === 'video' ? 'video' : 'photo',
    hasThumbnail: !!f.hasThumbnail, description: f.description || '', link: f.webViewLink || ''
  };
}

// ---------- helpers ----------

function driveGet_(path, params) {
  return driveCall_('get', path + '?' + query_(params));
}

function drivePost_(path, body, fields) {
  return driveCall_('post', path + '?fields=' + encodeURIComponent(fields), body);
}

function drivePatch_(path, body) {
  return driveCall_('patch', path + '?fields=id', body);
}

function driveCall_(method, path, body) {
  var opts = { method: method, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true };
  if (body) { opts.contentType = 'application/json; charset=UTF-8'; opts.payload = JSON.stringify(body); }
  var res = UrlFetchApp.fetch(DRIVE + path, opts);
  var code = res.getResponseCode();
  if (code === 404) throw userError_('not_found', 'That item is not in the library.');
  if (code >= 300) {
    console.error('Drive ' + method + ' ' + path + ' -> ' + code + ' ' + res.getContentText());
    throw userError_('drive_error', 'Google Drive did not answer. Try again in a minute.');
  }
  return JSON.parse(res.getContentText() || '{}');
}

function query_(params) {
  return Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
}

function q_(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function prop_(k, d) { var v = PropertiesService.getScriptProperties().getProperty(k); return v == null || v === '' ? d : v; }
function userError_(code, message) { var e = new Error(message); e.userCode = code; return e; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
