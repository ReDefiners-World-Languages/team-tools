// Salesforce classes -> Content Studio board (Apps Script, same project as Code.gs). Nothing private lives in this file.
//
// WHAT IT DOES
//  Pulls CLASS-LEVEL data (no student, parent or teacher names, emails or phones, no Salesforce ids stored or logged)
//  from Salesforce into the board's `classes` items. Salesforce is the source of truth for these classes:
//    Class (name), Program code, Site, Day, Time, End date, Enrolled, Attended (attendance %), n (attendance records).
//  The script writes to the BOARD STORE (the same lock, revision and dirty list as a board save). The normal one-way
//  table sync then copies the classes into the Classes tab. Nothing in the Classes tab is ever read back, and the board
//  cannot edit classes (the page shows them read-only; the server refuses class changes from the web).
//
// SALESFORCE OBJECTS AND FIELDS (confirmed read-only against the org, API v66.0)
//  SFDC_Class__c ("Class"): Name, Program__r.Name (program), Location_Name__c (site), Facility__c (site fallback),
//    Class_Schedule__c (multipicklist like "3:00 PM - 4:00 PM Thursday" or "5:30 PM - 6:30 PM Tues/Thurs"),
//    Class_Schedule_Text__c (fallback text), End_Date__c, Total_Enrollments__c, Status__c.
//  hed__Attendance_Event__c ("Attendance Event"): Class__c, hed__Attendance_Type__c (Present, Tardy, Absent,
//    Enrolled After Start Date). Only COUNTS per class are read (GROUP BY), never rows of people.
//
// RULES (change the constants below to change a rule)
//  - Which classes: Status "Active" and End Date today or later (or no end date).
//  - Day/time come from Class_Schedule__c text. A class meeting on several days becomes one row PER DAY (so the board's
//    visit calendar shows it on each day). Day numbers follow the workbook: 1 = Monday ... 7 = Sunday.
//  - Matching a Salesforce class to a board class: the class NAME plus the day (no Salesforce id is kept).
//  - Attended = round(100 x (Present + Tardy) / (Present + Tardy + Absent)); n = Present + Tardy + Absent.
//    "Enrolled After Start Date" records are not counted.
//  - A class that is no longer in the pull is FLAGGED "Not in Salesforce" and kept, never deleted.
//  - Audience and End note are not in Salesforce: kept as they are on the board class (empty for new classes).
//  - Per-row result and time: kept on each class (sfRes, sfAt), copied to the optional Classes columns "SF Sync" and
//    "SF Synced at" if those two columns exist right after "Updated by", and written to the execution log.
//
// SETUP, RUN AND STOP: see SETUP-GUIDE (private). In short: Script Properties SF_CLIENT_ID, SF_USERNAME, SF_PRIVATE_KEY
// (and SF_LOGIN_URL if not production) copied from the onboarding script, then run sfcTestConnection, sfcDryRun,
// sfcRun, and sfcSetupDailyTrigger. Everything runs from the editor; there is no menu and no web action.

var SFC_API = 'v66.0';
var SFC_SCHEDULE_TIMEZONE = 'America/New_York';
var SFC_SCHEDULE_HOURS = [5]; // 5 AM Eastern, once a day
var SFC_SCHEDULED_FUNCTION = 'sfcRunScheduled';
var SFC_WHO = 'salesforce sync';
var SFC_ENROLLED_AFTER = 'Enrolled After Start Date';
var SFC_DAY_WORDS = [['mon', 1], ['tue', 2], ['wed', 3], ['thu', 4], ['fri', 5], ['sat', 6], ['sun', 7]];

var SFC_CLASS_SOQL = "SELECT Id, Name, Program__r.Name, Location_Name__c, Facility__c, Class_Schedule__c, Class_Schedule_Text__c, End_Date__c, Total_Enrollments__c " +
  "FROM SFDC_Class__c WHERE Status__c = 'Active' AND (End_Date__c >= TODAY OR End_Date__c = NULL) ORDER BY Name";
var SFC_ATTENDANCE_SOQL = "SELECT Class__c, hed__Attendance_Type__c, COUNT(Id) cnt FROM hed__Attendance_Event__c " +
  "WHERE Class__r.Status__c = 'Active' AND (Class__r.End_Date__c >= TODAY OR Class__r.End_Date__c = NULL) GROUP BY Class__c, hed__Attendance_Type__c";

// ---------- editor entry points ----------

// Logs in and counts the active classes. Changes nothing.
function sfcTestConnection() {
  var auth = getSalesforceToken_();
  var r = sfc_query_(auth, "SELECT COUNT() FROM SFDC_Class__c WHERE Status__c = 'Active' AND (End_Date__c >= TODAY OR End_Date__c = NULL)");
  console.log('Salesforce login works. Active classes ending today or later: ' + r.totalSize + '.');
}

// Shows what a real run would do. Writes nothing (to Salesforce, the store or the workbook).
function sfcDryRun() { return sfc_run_(true); }

// Updates the board's classes from Salesforce.
function sfcRun() { return sfc_run_(false); }

// The daily trigger calls this (no user, no dialogs).
function sfcRunScheduled() { return sfc_run_(false); }

function sfcSetupDailyTrigger() {
  sfcRemoveDailyTrigger();
  SFC_SCHEDULE_HOURS.forEach(function (hour) {
    ScriptApp.newTrigger(SFC_SCHEDULED_FUNCTION).timeBased().atHour(hour).everyDays(1).inTimezone(SFC_SCHEDULE_TIMEZONE).create();
  });
  console.log('Daily trigger set for ' + SFC_SCHEDULED_FUNCTION + ' at ' + SFC_SCHEDULE_HOURS.join(':00 and ') + ':00 ' + SFC_SCHEDULE_TIMEZONE + ' (it fires some minute inside that hour).');
}

function sfcRemoveDailyTrigger() {
  var n = 0;
  ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === SFC_SCHEDULED_FUNCTION; }).forEach(function (t) { ScriptApp.deleteTrigger(t); n++; });
  console.log(n + ' trigger(s) removed.');
}

// ---------- the run ----------

function sfc_run_(dry) {
  ss_ = null;
  var auth = getSalesforceToken_();
  var sf = sfc_pull_(auth);
  if (!sf.length) throw new Error('Salesforce returned no active classes. Nothing was changed (an empty answer is never used to flag or remove classes).');
  var stampText = Utilities.formatDate(new Date(nowMs_()), SFC_SCHEDULE_TIMEZONE, 'yyyy-MM-dd h:mm a z');
  if (dry) {
    var plan = sfc_plan_(sf, sfc_existing_(st_load_(store_())), stampText, Number(prop_('SFC_ID_MAX', '0')));
    sfc_log_(plan, true, stampText);
    return sfc_counts_(plan);
  }
  var result = withLock_(30000, function () {
    var data = st_load_(store_());
    var plan = sfc_plan_(sf, sfc_existing_(data), stampText, Number(prop_('SFC_ID_MAX', '0')));
    var ops = plan.filter(function (a) { return a.item; }).map(function (a) { return { c: 'classes', id: String(a.item.id), v: a.item }; });
    var res = ops.length ? storeApply_(ops, SFC_WHO, { allowClasses: true }) : { rejected: [] };
    if (res.rejected && res.rejected.length) throw new Error('The store refused ' + res.rejected.length + ' class(es): ' + res.rejected[0].message);
    var maxId = 0; plan.forEach(function (a) { if (a.item && a.item.id > maxId) maxId = a.item.id; });
    if (maxId > Number(prop_('SFC_ID_MAX', '0'))) PropertiesService.getScriptProperties().setProperty('SFC_ID_MAX', String(maxId));
    sfc_log_(plan, false, stampText);
    return plan;
  });
  PropertiesService.getScriptProperties().setProperty('SFC_LAST', JSON.stringify({ at: stampText, counts: sfc_counts_(result) }));
  return sfc_counts_(result);
}

function sfc_counts_(plan) {
  var c = { new: 0, changed: 0, same: 0, missing: 0, flagged: 0 };
  plan.forEach(function (a) { c[a.kind] = (c[a.kind] || 0) + 1; });
  return c;
}

function sfc_log_(plan, dry, stampText) {
  var c = sfc_counts_(plan);
  console.log((dry ? 'DRY RUN (nothing written). ' : 'Done. ') + stampText + ': ' + c.new + ' new, ' + c.changed + ' changed, ' + c.same + ' unchanged, ' + c.missing + ' newly flagged not in Salesforce, ' + c.flagged + ' already flagged.');
  plan.forEach(function (a) { console.log(a.log); });
}

// ---------- Salesforce reads (class-level only) ----------

function sfc_get_(auth, pathOrUrl) {
  var res = UrlFetchApp.fetch(auth.instanceUrl + pathOrUrl, { method: 'get', headers: { Authorization: 'Bearer ' + auth.accessToken }, muteHttpExceptions: true });
  var code = res.getResponseCode(), body = res.getContentText();
  if (code !== 200 && code !== 201) throw new Error('Salesforce answered ' + code + ': ' + String(body).slice(0, 500));
  return JSON.parse(body);
}

function sfc_query_(auth, soql) {
  var first = sfc_get_(auth, '/services/data/' + SFC_API + '/query?q=' + encodeURIComponent(soql));
  var records = first.records || [];
  var next = first.nextRecordsUrl;
  while (next) { var more = sfc_get_(auth, next); records = records.concat(more.records || []); next = more.nextRecordsUrl; }
  return { totalSize: first.totalSize, records: records };
}

// Returns one entry per Salesforce class and day: { name, prog, site, day, time, end, enr, att, n }. No ids leave this function.
function sfc_pull_(auth) {
  var classes = sfc_query_(auth, SFC_CLASS_SOQL).records;
  var counts = {};
  sfc_query_(auth, SFC_ATTENDANCE_SOQL).records.forEach(function (r) {
    var cid = r.Class__c, t = r.hed__Attendance_Type__c, n = Number(r.cnt || r.expr0 || 0);
    (counts[cid] = counts[cid] || {})[t] = n;
  });
  return sfc_rows_(classes, counts);
}

// Pure: Salesforce rows + attendance counts -> board class rows. (Tested with a stub.)
function sfc_rows_(classes, counts) {
  var out = [], seen = {};
  classes.forEach(function (c) {
    var name = String(c.Name || '').trim();
    if (!name) return;
    var att = counts[c.Id] || {}, present = (att.Present || 0) + (att.Tardy || 0), absent = att.Absent || 0, n = present + absent;
    var sched = sfc_schedules_(c.Class_Schedule__c || c.Class_Schedule_Text__c || '');
    if (!sched.length) sched = [{ day: '', time: '' }];
    var site = String(c.Location_Name__c || '').trim() || String(c.Facility__c || '').split(',')[0].trim();
    var prog = sfc_program_(c.Program__r && c.Program__r.Name);
    sched.forEach(function (s) {
      var key = name + '|' + s.day;
      if (seen[key]) key += '|' + s.time; // two sessions on the same day at different times
      seen[key] = true;
      out.push({ key: key, name: name, prog: prog, site: site, day: s.day, time: s.time, end: c.End_Date__c || '', enr: Math.round(Number(c.Total_Enrollments__c || 0)), att: n ? Math.round(100 * present / n) : 0, n: n });
    });
  });
  return out;
}

function sfc_program_(name) {
  name = String(name || '').trim();
  var m = /\(([^)]+)\)\s*$/.exec(name);
  return m ? m[1].trim() : name;
}

// "3:00 PM - 4:00 PM Tues/Thurs" (or several values joined by ";") -> [{ day: 2, time: '15:00' }, { day: 4, time: '15:00' }]
function sfc_schedules_(text) {
  var out = [];
  String(text || '').split(';').forEach(function (part) {
    var m = /(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]/.exec(part), time = '';
    if (m) { var h = +m[1] % 12 + (/[Pp]/.test(m[3]) ? 12 : 0); time = (h < 10 ? '0' : '') + h + ':' + m[2]; }
    var rest = m ? part.slice(m.index + m[0].length) : part, days = [];
    var re = /\b(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/gi, w;
    while ((w = re.exec(rest))) {
      var d = SFC_DAY_WORDS.filter(function (p) { return w[1].toLowerCase().indexOf(p[0]) === 0; })[0][1];
      if (days.indexOf(d) < 0) days.push(d);
    }
    days.forEach(function (d) { out.push({ day: d, time: time }); });
    if (!days.length && time) out.push({ day: '', time: time });
  });
  return out;
}

// ---------- planning (pure; the same function serves the dry run and the real run) ----------

// Existing board classes from the store: [{ item }], matched later by sfKey or by name|day.
function sfc_existing_(data) {
  return data.items.filter(function (it) { return it.c === 'classes'; }).map(function (it) { return st_parse_(it); }).filter(function (v) { return v; });
}

function sfc_plan_(sf, existing, stampText, idMax) {
  var byKey = {}, plan = [], seen = {};
  existing.forEach(function (c) { byKey[c.sfKey || (c.name + '|' + (c.day === undefined ? '' : c.day))] = c; });
  var nextId = Math.max(idMax || 0, existing.reduce(function (m, c) { return Math.max(m, Number(c.id) || 0); }, 0));
  sf.forEach(function (r) {
    seen[r.key] = true;
    var old = byKey[r.key];
    var fields = { prog: r.prog, name: r.name, site: r.site, day: r.day, time: r.time, end: r.end, enr: r.enr, att: r.att, n: r.n };
    if (!old) {
      var item = Object.assign({ id: ++nextId, aud: '', endTxt: '' }, fields, { sfKey: r.key, sfRes: 'New ✅', sfAt: stampText });
      plan.push({ kind: 'new', key: r.key, item: item, log: '[New ✅] ' + r.name + ' | day ' + (r.day || '?') + ' ' + (r.time || '') + ' | enrolled ' + r.enr + ' | ' + stampText });
      return;
    }
    var diffs = Object.keys(fields).filter(function (k) { return String(old[k] === undefined ? '' : old[k]) !== String(fields[k]); });
    var wasMissing = /^Not in Salesforce/.test(old.sfRes || '');
    if (!diffs.length && !wasMissing && old.sfKey === r.key) {
      plan.push({ kind: 'same', key: r.key, item: null, log: '[Synced ✅] ' + r.name + ' | day ' + (r.day || '?') + ' | no change' });
      return;
    }
    var what = wasMissing ? 'back in Salesforce' : diffs.map(function (k) { return k + ' ' + (old[k] === undefined ? '' : old[k]) + ' to ' + fields[k]; }).join(', ');
    var next = Object.assign({}, old, fields, { sfKey: r.key, sfRes: 'Changed ✅ (' + what + ')', sfAt: stampText });
    plan.push({ kind: 'changed', key: r.key, item: next, log: '[Changed ✅] ' + r.name + ' | ' + what + ' | ' + stampText });
  });
  existing.forEach(function (c) {
    if (!c.sfKey || seen[c.sfKey]) return; // classes that never came from Salesforce are left alone
    if (/^Not in Salesforce/.test(c.sfRes || '')) {
      plan.push({ kind: 'flagged', key: c.sfKey, item: null, log: '[Not in Salesforce ⚠️] ' + c.name + ' | day ' + (c.day || '?') + ' | already flagged, kept' });
      return;
    }
    var flagged = Object.assign({}, c, { sfRes: 'Not in Salesforce ⚠️ (ended, cancelled or removed; kept)', sfAt: stampText });
    plan.push({ kind: 'missing', key: c.sfKey, item: flagged, log: '[Not in Salesforce ⚠️] ' + c.name + ' | day ' + (c.day || '?') + ' | flagged, kept (not deleted) | ' + stampText });
  });
  return plan;
}

// ---------- Salesforce login (JWT Bearer flow, copied unchanged from the ReDefiners onboarding script) ----------
// Script Properties: SF_CLIENT_ID, SF_USERNAME, SF_PRIVATE_KEY (PKCS#8 PEM) and optionally SF_LOGIN_URL.
// Never log or paste these values. Anyone who can edit this project can read them: limit who edits the script.

/** Signs a JWT with the private key and exchanges it for an access token. */
function getSalesforceToken_() {
  const props = PropertiesService.getScriptProperties();
  const loginUrl = props.getProperty('SF_LOGIN_URL') || 'https://login.salesforce.com';
  const clientId = props.getProperty('SF_CLIENT_ID');
  const username = props.getProperty('SF_USERNAME');
  const privateKey = props.getProperty('SF_PRIVATE_KEY');

  if (!clientId || !username || !privateKey) {
    throw new Error(
      'Missing Salesforce credentials. Add SF_CLIENT_ID, SF_USERNAME and SF_PRIVATE_KEY ' +
      '(and SF_LOGIN_URL) in Project Settings → Script Properties.'
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { iss: clientId, sub: username, aud: loginUrl, exp: now + 180 };

  function base64url(obj) {
    return Utilities.base64EncodeWebSafe(JSON.stringify(obj)).replace(/=+$/, '');
  }
  const signingInput = base64url(header) + '.' + base64url(claims);

  // Re-wrap the PEM into 64-char lines in case Script Properties lost the line breaks.
  const pemBody = privateKey
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const pem = '-----BEGIN PRIVATE KEY-----\n' + pemBody.match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----';

  const signature = Utilities.computeRsaSha256Signature(signingInput, pem);
  const jwt = signingInput + '.' + Utilities.base64EncodeWebSafe(signature).replace(/=+$/, '');

  const res = UrlFetchApp.fetch(loginUrl + '/services/oauth2/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
             '&assertion=' + encodeURIComponent(jwt),
    muteHttpExceptions: true,
  });
  const result = JSON.parse(res.getContentText());
  if (result.error) {
    throw new Error('SF JWT auth error: ' + result.error + ' — ' + result.error_description);
  }
  return { accessToken: result.access_token, instanceUrl: result.instance_url };
}
