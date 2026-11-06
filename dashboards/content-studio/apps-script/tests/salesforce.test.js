'use strict';
// Tests of the Salesforce classes sync with a stubbed Salesforce API (no real login, no real data).
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./harness');

function sfClass(id, name, schedule, enr, extra = {}) {
  return Object.assign({ Id: id, Name: name, Program__r: { Name: 'Multilingual Citizens Program (MCP)' }, Location_Name__c: 'Example CBFRC', Facility__c: 'Example CBFRC, 1 Main St, Tampa, FL', Class_Schedule__c: schedule, Class_Schedule_Text__c: null, End_Date__c: '2027-01-28', Total_Enrollments__c: enr }, extra);
}
function setup(opts = {}) {
  const env = makeEnv(opts);
  const sf = { classes: [], attendance: [], calls: [] };
  env.ctx.getSalesforceToken_ = () => ({ accessToken: 'TEST', instanceUrl: 'https://sf.example' });
  env.fetchHandler = (url) => {
    if (/tokeninfo/.test(url)) return env.defaultFetch(url);
    sf.calls.push(url);
    const q = decodeURIComponent((/[?&]q=(.*)$/.exec(url) || [])[1] || '');
    if (/COUNT\(\)/.test(q)) return { code: 200, body: { totalSize: sf.classes.length, done: true, records: [] } };
    if (/FROM SFDC_Class__c/.test(q)) return { code: 200, body: { totalSize: sf.classes.length, done: true, records: sf.classes } };
    if (/FROM hed__Attendance_Event__c/.test(q)) return { code: 200, body: { totalSize: sf.attendance.length, done: true, records: sf.attendance } };
    return { code: 404, body: 'nope' };
  };
  const stored = () => { const sh = env.wb.store; const n = sh.getLastRow(); return n < 2 ? [] : sh.getRange(2, 1, n - 1, 5).getDisplayValues().filter((r) => r[0] === 'classes').map((r) => JSON.parse(r[2])); };
  const table = () => { const sh = env.wb.getSheetByName('Classes'); const n = sh.getLastRow(); return n < 2 ? [] : sh.getRange(2, 1, n - 1, Math.min(16, sh.maxCols)).getDisplayValues(); };
  return { env, sf, stored, table, tick: () => env.run('syncTick()') };
}
const att = (cls, type, n) => ({ Class__c: cls, hed__Attendance_Type__c: type, cnt: n });

test('schedule text parser: times, one or several days, abbreviations, several values', () => {
  const { env } = setup();
  const fn = env.ctx.sfc_schedules_; const p = (t) => JSON.stringify(fn(t));
  assert.equal(p('3:00 PM - 4:00 PM Thursday'), '[{"day":4,"time":"15:00"}]');
  assert.equal(p('5:30 PM - 6:30 PM Tues/Thurs'), '[{"day":2,"time":"17:30"},{"day":4,"time":"17:30"}]');
  assert.equal(p('2:00 PM - 3:00 PM Wednesday and Thursday'), '[{"day":3,"time":"14:00"},{"day":4,"time":"14:00"}]');
  assert.equal(p('6:00 PM - 7:00 PM Wed/Fri'), '[{"day":3,"time":"18:00"},{"day":5,"time":"18:00"}]');
  assert.equal(p('10:00 AM - 12:00 PM Saturday'), '[{"day":6,"time":"10:00"}]');
  assert.equal(p('12:30 PM - 2:30 PM Wednesday'), '[{"day":3,"time":"12:30"}]');
  assert.equal(p('12:15 AM Monday'), '[{"day":1,"time":"00:15"}]');
  assert.equal(p('9:00 AM Mon; 1:00 PM Sunday'), '[{"day":1,"time":"09:00"},{"day":7,"time":"13:00"}]');
  assert.equal(p('To be announced'), '[]');
  assert.equal(p(''), '[]');
  assert.equal(env.ctx.sfc_program_('Multilingual Citizens Program (MCP)'), 'MCP');
  assert.equal(env.ctx.sfc_program_('Other Program'), 'Other Program');
});

test('test connection only counts, writes nothing', () => {
  const t = setup(); t.sf.classes = [sfClass('SFID-1', 'A', '3:00 PM - 4:00 PM Thursday', 4)];
  const w = { ...t.env.wb.stats };
  t.env.run('sfcTestConnection()');
  assert.deepEqual(t.env.wb.stats, w);
});

test('dry run writes nothing (store, tables, properties) and logs every row', () => {
  const t = setup();
  t.sf.classes = [sfClass('SFID-1', 'North CBFRC - ESOL (5.1)', '5:30 PM - 6:30 PM Tues/Thurs', 11), sfClass('SFID-2', 'Temple CBFRC - Spanish (5.1)', '3:00 PM - 4:00 PM Thursday', 4)];
  const logs = [];
  t.env.ctx.console = { log: (m) => logs.push(m), error() {} };
  const s = { ...t.env.wb.stats }, pw = t.env.counters.propWrites;
  const counts = t.env.run('sfcDryRun()');
  assert.deepEqual(counts, { new: 3, changed: 0, same: 0, missing: 0, flagged: 0 });
  assert.equal(t.env.wb.stats.write, s.write);
  assert.equal(t.env.counters.propWrites, pw);
  assert.equal(t.stored().length, 0);
  assert.equal(logs.filter((l) => /^\[New/.test(l)).length, 3);
  assert.ok(logs[0].startsWith('DRY RUN (nothing written)'));
});

test('real run adds class rows (one per day), the sync mirrors them to the Classes tab with the workbook day numbers', () => {
  const t = setup();
  t.sf.classes = [sfClass('SFID-1', 'North CBFRC - ESOL (5.1)', '5:30 PM - 6:30 PM Tues/Thurs', 11), sfClass('SFID-2', 'Temple CBFRC - Spanish (5.1)', '3:00 PM - 4:00 PM Thursday', 4)];
  t.sf.attendance = [att('SFID-1', 'Present', 30), att('SFID-1', 'Absent', 10), att('SFID-1', 'Tardy', 5), att('SFID-1', 'Enrolled After Start Date', 3), att('SFID-2', 'Present', 2)];
  const c = t.env.run('sfcRun()');
  assert.deepEqual(c, { new: 3, changed: 0, same: 0, missing: 0, flagged: 0 });
  const s = t.stored();
  assert.deepEqual(s.map((x) => [x.id, x.name, x.day, x.time, x.enr, x.att, x.n, x.prog, x.site, x.end]), [
    [1, 'North CBFRC - ESOL (5.1)', 2, '17:30', 11, 78, 45, 'MCP', 'Example CBFRC', '2027-01-28'],
    [2, 'North CBFRC - ESOL (5.1)', 4, '17:30', 11, 78, 45, 'MCP', 'Example CBFRC', '2027-01-28'],
    [3, 'Temple CBFRC - Spanish (5.1)', 4, '15:00', 4, 100, 2, 'MCP', 'Example CBFRC', '2027-01-28']]);
  assert.equal(s[0].sfRes, 'New ✅');
  assert.match(s[0].sfAt, /^2026-11-06 3:30 PM E[SD]T$/);
  t.tick();
  const rows = t.table();
  assert.deepEqual(rows[0].slice(0, 12), ['1', 'MCP', 'North CBFRC - ESOL (5.1)', 'Example CBFRC', '2', '17:30', '', '2027-01-28', '', '11', '78', '45']);
  assert.equal(rows[1][4], '4', 'Thursday = 4');
  assert.equal(rows[0][12], '2026-11-06 15:30:00');
  assert.equal(rows[0][13], 'salesforce sync');
  assert.equal(t.env.run('verifyStoreAgainstTables()').differences, 0);
});

test('no Salesforce id, token or credential reaches the store, the tables or the logs', () => {
  const t = setup({ classLog: true });
  t.sf.classes = [sfClass('SFID-1', 'A', '3:00 PM Thursday', 4)];
  const logs = [];
  t.env.ctx.console = { log: (m) => logs.push(m), error() {} };
  t.env.run('sfcRun()'); t.tick();
  const all = JSON.stringify([...t.env.wb.sheets.map((s) => s.getRange(1, 1, Math.min(s.maxRows, 60), s.maxCols).getDisplayValues())]) + logs.join('\n') + t.env.logs.join('\n') + JSON.stringify([...t.env.props.entries()]);
  assert.ok(!/SFID|Bearer|TEST"/.test(all.replace(/accessToken/g, '')), 'found an id or token');
});

test('re-running with nothing changed writes nothing (idempotent)', () => {
  const t = setup();
  t.sf.classes = [sfClass('SFID-1', 'A', '3:00 PM Thursday', 4), sfClass('SFID-2', 'B', '4:00 PM Wed/Fri', 6)];
  t.sf.attendance = [att('SFID-1', 'Present', 8), att('SFID-1', 'Absent', 2)];
  t.env.run('sfcRun()'); t.tick();
  const w = { ...t.env.wb.stats }, rev = t.env.props.get('BOARD_REV'), dirty = t.env.props.get('SYNC_DIRTY');
  const c = t.env.run('sfcRun()');
  assert.deepEqual(c, { new: 0, changed: 0, same: 3, missing: 0, flagged: 0 });
  assert.equal(t.env.wb.stats.write, w.write);
  assert.equal(t.env.props.get('BOARD_REV'), rev);
  assert.equal(t.env.props.get('SYNC_DIRTY'), dirty);
});

test('a changed enrolled count updates only that class, in the store and in the table', () => {
  const t = setup();
  t.sf.classes = [sfClass('SFID-1', 'A', '3:00 PM Thursday', 4), sfClass('SFID-2', 'B', '4:00 PM Friday', 6)];
  t.env.run('sfcRun()'); t.tick();
  const before = t.table();
  t.env.clock.t += 3600000;
  t.sf.classes[1].Total_Enrollments__c = 9;
  const c = t.env.run('sfcRun()');
  assert.deepEqual(c, { new: 0, changed: 1, same: 1, missing: 0, flagged: 0 });
  const s = t.stored();
  assert.equal(s[0].enr, 4); assert.equal(s[1].enr, 9);
  assert.match(s[1].sfRes, /^Changed ✅ \(enr 6 to 9\)/);
  assert.equal(s[0].sfRes, 'New ✅', 'the untouched class keeps its log');
  const w = t.env.wb.stats.write;
  t.tick();
  assert.equal(t.env.wb.stats.write - w, 1, 'one row written in the Classes tab');
  const after = t.table();
  assert.deepEqual(after[0], before[0]);
  assert.equal(after[1][9], '9');
  assert.equal(after[1][12], '2026-11-06 16:30:00');
});

test('an unknown class is added with the next id; ids are never reused', () => {
  const t = setup();
  t.sf.classes = [sfClass('SFID-1', 'A', '3:00 PM Thursday', 4), sfClass('SFID-2', 'B', '4:00 PM Friday', 6)];
  t.env.run('sfcRun()');
  t.sf.classes = [sfClass('SFID-1', 'A', '3:00 PM Thursday', 4), sfClass('SFID-3', 'C', '1:00 PM Monday', 2)];
  const c = t.env.run('sfcRun()');
  assert.equal(c.new, 1);
  assert.deepEqual(t.stored().map((x) => [x.id, x.name]), [[1, 'A'], [2, 'B'], [3, 'C']]);
  assert.equal(t.env.props.get('SFC_ID_MAX'), '3');
});

test('a class missing from Salesforce is flagged, kept and not deleted; flagged once; back again = changed', () => {
  const t = setup({ classLog: true });
  t.sf.classes = [sfClass('SFID-1', 'A', '3:00 PM Thursday', 4), sfClass('SFID-2', 'B', '4:00 PM Friday', 6)];
  t.env.run('sfcRun()'); t.tick();
  t.sf.classes = [t.sf.classes[0]];
  let c = t.env.run('sfcRun()');
  assert.deepEqual(c, { new: 0, changed: 0, same: 1, missing: 1, flagged: 0 });
  let s = t.stored();
  assert.equal(s.length, 2);
  assert.match(s[1].sfRes, /^Not in Salesforce ⚠️/);
  assert.equal(s[1].enr, 6, 'values kept');
  t.tick();
  assert.match(t.table()[1][14], /^Not in Salesforce/, 'the optional SF Sync column shows it');
  assert.equal(t.table().length, 2, 'the row is still there');
  const w = t.env.wb.stats.write;
  c = t.env.run('sfcRun()');
  assert.deepEqual(c, { new: 0, changed: 0, same: 1, missing: 0, flagged: 1 });
  assert.equal(t.env.wb.stats.write, w, 'already flagged: no write');
  t.sf.classes = [sfClass('SFID-1', 'A', '3:00 PM Thursday', 4), sfClass('SFID-2', 'B', '4:00 PM Friday', 6)];
  c = t.env.run('sfcRun()');
  assert.equal(c.changed, 1);
  assert.match(t.stored()[1].sfRes, /back in Salesforce/);
});

test('an empty answer from Salesforce stops the run and changes nothing', () => {
  const t = setup();
  t.sf.classes = [sfClass('SFID-1', 'A', '3:00 PM Thursday', 4)];
  t.env.run('sfcRun()');
  t.sf.classes = [];
  const w = t.env.wb.stats.write;
  assert.throws(() => t.env.run('sfcRun()'), /returned no active classes/);
  assert.throws(() => t.env.run('sfcDryRun()'), /returned no active classes/);
  assert.equal(t.env.wb.stats.write, w);
  assert.equal(t.stored().length, 1);
  assert.doesNotMatch(t.stored()[0].sfRes, /Not in/);
});

test('Salesforce errors give a clear message with the status', () => {
  const t = setup();
  t.env.fetchHandler = () => ({ code: 401, body: '[{"message":"Session expired","errorCode":"INVALID_SESSION_ID"}]' });
  assert.throws(() => t.env.run('sfcRun()'), /Salesforce answered 401: .*Session expired/);
});

test('class-level data only: the queries never ask for people, and only counts are read for attendance', () => {
  const t = setup();
  t.sf.classes = [sfClass('SFID-1', 'A', '3:00 PM Thursday', 4)];
  t.env.run('sfcRun()');
  const q = t.sf.calls.map((u) => decodeURIComponent(u)).join('\n');
  assert.ok(!/Contact__c|Co_Instructor|Instructor|Email|Phone|hed__Contact__c|Enrollment__c,|Student/i.test(q.replace(/hed__Attendance_Event__c/g, '')), q);
  assert.match(q, /GROUP BY Class__c, hed__Attendance_Type__c/);
});

test('a class that meets on two sessions the same day keeps both rows; a class with no readable day is kept with an empty day', () => {
  const t = setup();
  t.sf.classes = [sfClass('SFID-1', 'A', '9:00 AM Monday;1:00 PM Monday', 4), sfClass('SFID-2', 'B', 'to be announced', 3)];
  t.env.run('sfcRun()');
  assert.deepEqual(t.stored().map((x) => [x.name, x.day, x.time]), [['A', 1, '09:00'], ['A', 1, '13:00'], ['B', '', '']]);
  t.tick();
  assert.equal(t.table()[2][4], '');
  assert.equal(t.env.run('verifyStoreAgainstTables()').differences, 0);
});

test('daily trigger: installed in Eastern time, replaced (not duplicated) when set up twice, removable', () => {
  const t = setup();
  t.env.run('sfcSetupDailyTrigger()'); t.env.run('sfcSetupDailyTrigger()');
  assert.equal(t.env.counters.triggers.length, 1);
  assert.equal(t.env.counters.triggers[0].tz, 'America/New_York');
  assert.equal(t.env.counters.triggers[0].fn, 'sfcRunScheduled');
  t.env.run('sfcRemoveDailyTrigger()');
  assert.equal(t.env.counters.triggers.length, 0);
});

test('the board cannot change classes; the sync can, and the board sees the new revision', () => {
  const t = setup();
  const tok = t.env.token('alex@redefinerswl.org');
  t.sf.classes = [sfClass('SFID-1', 'A', '3:00 PM Thursday', 4)];
  const r0 = t.env.call('start', {}, tok).data.rev;
  t.env.run('sfcRun()');
  const r1 = t.env.call('heartbeat', { view: 'x' }, tok).data.rev;
  assert.equal(r1, r0 + 1);
  assert.equal(t.env.call('board', {}, tok).data.board.classes.length, 1);
  assert.equal(t.env.call('save', { ops: [{ c: 'classes', id: '1', v: { id: 1, name: 'hack' } }] }, tok).ok, false);
});
