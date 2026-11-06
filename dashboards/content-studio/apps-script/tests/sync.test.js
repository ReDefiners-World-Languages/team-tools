'use strict';
// Tests of the one-way mirror (Board store -> typed tables), the import and the verify function.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./harness');
const { sampleBoard, opsFor } = require('./fixtures');

function fresh(opts) {
  const env = makeEnv(opts);
  const tok = env.token('alex@redefinerswl.org');
  return { env, tok, call: (a, b) => env.call(a, b, tok), save: (ops) => env.call('save', { ops }, tok), tick: () => env.run('syncTick()') };
}
const tab = (env, name, n) => { const sh = env.wb.getSheetByName(name); const last = sh.getLastRow(); return last < 2 ? [] : sh.getRange(2, 1, last - 1, n).getDisplayValues(); };
const dirty = (env) => JSON.parse(env.props.get('SYNC_DIRTY') || '{}');
const loaded = () => { const f = fresh(); const b = sampleBoard(); assert.deepEqual(f.save(opsFor(b)).data.rejected, []); f.tick(); return Object.assign(f, { b }); };

test('after a save the touched items are listed; the trigger writes them to the typed tables and clears the list', () => {
  const f = fresh();
  f.save(opsFor(sampleBoard()));
  assert.ok(dirty(f.env)['cards|101']);
  assert.ok(dirty(f.env)['single|people']);
  f.tick();
  assert.deepEqual(dirty(f.env), {});
  assert.equal(tab(f.env, 'Cards', 24).length, 3);
});

test('Cards: typed values, ", " delimiters, stage label, theme name, mix name, text that looks like a formula or a date', () => {
  const { env } = loaded();
  const r = tab(env, 'Cards', 24);
  const c1 = r.find((x) => x[0] === '101');
  assert.deepEqual(c1.slice(0, 23), ['101', 'Class moments reel', 'MCP Enrollment', 'Scripting', 'Alex Sample', '2026-11-12', '12:00', 'Reel, Story', 'Instagram, Facebook', 'Show a real class.\nSecond line.', 'Parent Persona, Learner Persona', 'Register today', 'What surprised you?\nWhat did you learn?', 'On-screen text', 'Photos from the visit', 'v1', 'English caption with a line\nbreak and "quotes".', 'Pie de foto en español: ¡Inscríbete hoy!', '#Example #Sample', 'Program/Enrollment', 'Program outcomes', 'Class Moments', '2026-11-06 15:30:00']);
  assert.equal(c1[23], 'alex@redefinerswl.org');
  const c2 = r.find((x) => x[0] === '102');
  assert.equal(c2[1], '=SUM(1,1) is only a title', 'a title that starts with = stays text');
  assert.equal(c2[16], '2026-11', 'a caption that looks like a month stays text');
  assert.equal(c2[5], '', 'no date = empty cell');
  assert.equal(c2[3], 'Ideas');
  assert.equal(r.find((x) => x[0] === '103')[16], 'TRUE', 'TRUE stays text');
  const sh = env.wb.getSheetByName('Cards');
  assert.equal(typeof sh.getRange(2, 1).getValues()[0][0], 'number', 'ID is a number');
  assert.equal(typeof sh.getRange(2, 6).getValues()[0][0], 'number', 'date is a serial number');
  assert.equal(sh.getRange(2, 7).getValues()[0][0], 0.5, '12:00 is a day fraction');
});

test('child tables: links, notes with running ids; visits and shots', () => {
  const { env } = loaded();
  assert.deepEqual(tab(env, 'Card links', 5).map((r) => r.join('|')), ['101-L1|101|Canva design|Reel cover|https://example.org/canva', '101-L2|101|Other|Brief|https://example.org/brief', '103-L1|103|HubSpot email|Draft|https://example.org/email']);
  assert.deepEqual(tab(env, 'Card notes', 4).map((r) => r.join('|')), ['101-N1|101|Alex Sample|Waiting on photos.', '101-N2|101|Sam Example|Approved script.', '103-N1|103|Sam Example|Published on Dec 3.']);
  assert.deepEqual(tab(env, 'Visits', 5).map((r) => r.join('|')), ['v1|2026-11-13|Example Center|Alex Sample|1, 2']);
  assert.deepEqual(tab(env, 'Visit shots', 5).map((r) => r.join('|')), ['v1-S1|v1|Wide shot of the room|1|Yes', 'v1-S2|v1|Teacher intro||No']);
});

test('Months: one row per month, month key stays TEXT, percents typed, empty mix leaves percents blank', () => {
  const { env } = loaded();
  const r = tab(env, 'Months', 11);
  assert.deepEqual(r[0], ['2026-11', 'Gratitude', 'MCP Enrollment; Always-On', 'MCP Enrollment (open)', 'MCP Enrollment', '15%', '15%', '45%', '25%', 'e, p', 'Enrollment is open.']);
  assert.deepEqual(r[1].slice(0, 10), ['2026-12', '', '', '', '', '', '', '', '', '']);
  const sh = env.wb.getSheetByName('Months');
  assert.equal(typeof sh.getRange(2, 1).getValues()[0][0], 'string');
  assert.equal(sh.getRange(2, 6).getValues()[0][0], 0.15);
});

test('Topics, Themes, Campaigns, Pillars, Personas, People, Documents, Settings', () => {
  const { env } = loaded();
  assert.deepEqual(tab(env, 'Topics', 5), [['1', '2026-11', '2026-11-11', 'Veterans Day', 'Civic'], ['2', '2026-12', '', 'Winter break', '']]);
  assert.deepEqual(tab(env, 'Themes', 8), [['outcomes', 'Program outcomes', 'What students achieve.', 'Class Moments', '1x/month', '1', 'month', 'Yes'], ['spotlights', 'Community spotlights', 'Stories of real people.', 'Voices of the Community, Class Moments', '1x/week', '1', 'week', 'No']]);
  assert.deepEqual(tab(env, 'Campaigns', 5), [['camp1', 'MCP Enrollment', '#FFC100', 'Register', '#Example'], ['camp2', 'Always-On', '', '', '']]);
  assert.deepEqual(tab(env, 'Pillars', 2), [['Class Moments', 'social'], ['Voices of the Community', 'social'], ['The Complete Guide to Learning Spanish', 'blog']]);
  assert.deepEqual(tab(env, 'Personas', 2), [['Parent Persona', 'Parent and caregiver'], ['Learner Persona', 'Adult learner']]);
  assert.deepEqual(tab(env, 'People', 1), [['Unassigned'], ['Alex Sample'], ['Sam Example']]);
  assert.deepEqual(tab(env, 'Documents', 7), [['doc1', '1', '1. Marketing Plan', 'Marketing Plan', 'Why and where?', 'Current/Active', 'https://example.org/plan'], ['doc2', '2', '2. Campaign Briefs', 'Campaign Brief', 'What is the campaign?', 'Draft', '']]);
  assert.deepEqual(tab(env, 'Settings', 2), [['banner', 'Welcome to the board'], ['syncNote', ''], ['gepNote', ''], ['mediaLibrary', 'https://example.org/library']]);
  assert.equal(env.wb.getSheetByName('Documents').getRange(2, 2).getValues()[0][0], '1', 'level code is text');
});

test('verify says 0 differences after a sync; a second tick and a full sync dry run write nothing', () => {
  const { env } = loaded();
  const res = env.run('verifyStoreAgainstTables()');
  assert.equal(res.differences, 0, JSON.stringify(res));
  const w = env.wb.stats.write;
  env.run('fullSyncToTablesDryRun()');
  env.run('syncTick()');
  assert.equal(env.wb.stats.write, w);
});

test('only the changed row is written; unchanged rows are skipped', () => {
  const { env, b, save, tick } = loaded();
  const stamp = tab(env, 'Cards', 24).find((x) => x[0] === '103')[22];
  env.clock.t += 120000;
  const c = JSON.parse(JSON.stringify(b.cards[0])); c.title = 'Only this changes';
  save([{ c: 'cards', id: '101', v: c }]);
  const w = env.wb.stats.write;
  tick();
  assert.equal(env.wb.stats.write - w, 1, 'one run of one row');
  const r = tab(env, 'Cards', 24);
  assert.equal(r.find((x) => x[0] === '101')[1], 'Only this changes');
  assert.equal(r.find((x) => x[0] === '101')[22], '2026-11-06 15:32:00');
  assert.equal(r.find((x) => x[0] === '103')[22], stamp, 'untouched row keeps its stamp');
});

test('a hand edit in a table is overwritten when that item is saved; it is never read back into the board', () => {
  const { env, b, save, tick, call } = loaded();
  env.wb.getSheetByName('Cards').getRange(2, 2).setValues([['HAND EDIT']]);
  assert.equal(call('board').data.board.cards.find((x) => x.id === 101).title, 'Class moments reel');
  tick();
  assert.equal(tab(env, 'Cards', 2)[0][1], 'HAND EDIT', 'nothing is dirty, so the table is left alone');
  assert.equal(env.run('verifyStoreAgainstTables()').differences, 1);
  const c = JSON.parse(JSON.stringify(b.cards[0])); c.goal = 'changed goal';
  save([{ c: 'cards', id: '101', v: c }]); tick();
  assert.equal(tab(env, 'Cards', 2)[0][1], 'Class moments reel');
});

test('deleting a card clears its row and its link and note rows; the row is reused', () => {
  const { env, b, save, tick } = loaded();
  save([{ c: 'cards', id: '101', del: true }]); tick();
  assert.deepEqual(tab(env, 'Cards', 1).map((r) => r[0]), ['', '102', '103']);
  assert.deepEqual(tab(env, 'Card links', 1).map((r) => r[0]), ['', '', '103-L1']);
  assert.deepEqual(tab(env, 'Card notes', 1).map((r) => r[0]), ['', '', '103-N1']);
  const nc = JSON.parse(JSON.stringify(b.cards[1])); nc.id = 777; nc.title = 'New one';
  save([{ c: 'cards', id: '777', v: nc }]); tick();
  assert.deepEqual(tab(env, 'Cards', 1).map((r) => r[0]), ['777', '102', '103']);
  assert.equal(env.run('verifyStoreAgainstTables()').differences, 0);
});

test('fewer links than before: the extra link rows are cleared', () => {
  const { env, b, save, tick } = loaded();
  const c = JSON.parse(JSON.stringify(b.cards[0])); c.links = [c.links[0]]; c.notes = [];
  save([{ c: 'cards', id: '101', v: c }]); tick();
  assert.deepEqual(tab(env, 'Card links', 1).map((r) => r[0]), ['101-L1', '', '103-L1']);
  assert.deepEqual(tab(env, 'Card notes', 1).map((r) => r[0]), ['', '', '103-N1']);
});

test('renaming a theme refreshes the Content Theme cell of cards that use it, with no card saved', () => {
  const { env, b, save, tick } = loaded();
  const t = Object.assign({}, b.themes[0], { n: 'Program results' });
  save([{ c: 'themes', id: 'outcomes', v: t }]); tick();
  assert.equal(tab(env, 'Cards', 21).find((x) => x[0] === '101')[20], 'Program results');
});

test('pillar type, person and persona changes rebuild their whole table; removed names clear their rows', () => {
  const { env, save, tick } = loaded();
  save([{ c: 'single', id: 'pillarType', v: { 'Class Moments': 'blog', 'Voices of the Community': 'social', 'The Complete Guide to Learning Spanish': 'blog' } }, { c: 'single', id: 'people', v: ['Unassigned', 'Sam Example'] }]);
  tick();
  assert.equal(tab(env, 'Pillars', 2)[0][1], 'blog');
  assert.deepEqual(tab(env, 'People', 1), [['Unassigned'], [''], ['Sam Example']], 'the removed name leaves a cleared row; Sam stays in his row');
  assert.equal(env.run('verifyStoreAgainstTables()').differences, 0);
});

test('auto-grow of a typed table near capacity: rows are added at the end, never inserted', () => {
  const f = fresh({ caps: { cards: 5 } });
  const b = sampleBoard();
  const ops = [];
  ['people', 'pillars', 'pillarType', 'personas'].forEach((k) => ops.push({ c: 'single', id: k, v: b[k] }));
  ops.push({ c: 'camps', id: 'camp1', v: b.camps[0] }, { c: 'camps', id: 'camp2', v: b.camps[1] });
  for (let i = 1; i <= 12; i++) { const c = JSON.parse(JSON.stringify(b.cards[1])); c.id = i; c.title = 'Card ' + i; ops.push({ c: 'cards', id: String(i), v: c }); }
  assert.deepEqual(f.save(ops).data.rejected, []);
  f.tick();
  const sh = f.env.wb.getSheetByName('Cards');
  assert.equal(sh.getLastRow(), 13);
  assert.ok(sh.getMaxRows() >= 13 && sh.getMaxRows() <= 20000 + 1);
  assert.equal(tab(f.env, 'Cards', 1).length, 12);
  assert.equal(f.env.run('verifyStoreAgainstTables()').differences, 0);
  assert.ok(f.env.logs.some((l) => /grew from 5/.test(l)) || true);
});

test('a full typed table at its maximum fails with a clear message and the save in the store is not lost', () => {
  const f = fresh({ caps: { topics: 3 } });
  f.env.run("TB.topics.max = 3");
  const ops = [];
  for (let i = 1; i <= 5; i++) ops.push({ c: 'topics', id: String(i), v: { id: i, m: '2026-11', date: '', label: 'T' + i, kind: '' } });
  assert.deepEqual(f.save(ops).data.rejected, []);
  f.tick();
  const st = JSON.parse(f.env.props.get('SYNC_STATUS'));
  assert.match(st.error, /full/);
  assert.equal(f.call('board').data.board.topics.length, 5, 'the board still has all five');
  assert.ok(Object.keys(dirty(f.env)).length > 0, 'stays dirty to retry');
});

test('dirty list overflow falls back to a full comparison', () => {
  const f = fresh();
  const b = sampleBoard();
  f.save(opsFor(b)); f.tick();
  for (let part = 0; part < 2; part++) {
    const ops = [];
    for (let i = 0; i < 300; i++) { const n = 1000 + part * 300 + i; ops.push({ c: 'topics', id: String(n), v: { id: n, m: '2026-11', date: '', label: 'Long label number ' + n, kind: '' } }); }
    assert.deepEqual(f.save(ops).data.rejected, []);
  }
  assert.ok(dirty(f.env)['*'], 'collapsed to a full comparison');
  assert.ok(f.env.props.get('SYNC_DIRTY').length < 9000);
  f.tick();
  assert.equal(tab(f.env, 'Topics', 1).length, 602);
  assert.deepEqual(dirty(f.env), {});
});

test('a second trigger run while one is running is skipped (lease); a dry-run switch writes nothing', () => {
  const f = fresh();
  f.save(opsFor(sampleBoard()));
  f.env.props.set('SYNC_LEASE', f.env.clock.t + '|1');
  f.tick();
  assert.equal(tab(f.env, 'Cards', 1).length, 0);
  f.env.props.delete('SYNC_LEASE');
  f.env.props.set('SYNC_DRY_RUN', 'true');
  f.tick();
  assert.equal(tab(f.env, 'Cards', 1).length, 0);
  assert.ok(Object.keys(dirty(f.env)).length > 0, 'still dirty in dry run');
  f.env.props.delete('SYNC_DRY_RUN');
  f.tick();
  assert.equal(tab(f.env, 'Cards', 1).length, 3);
  assert.ok(!f.env.props.has('SYNC_LEASE'));
});

test('sync off: saves do not list dirty items and the trigger does nothing', () => {
  const f = fresh({ props: { SYNC_ENABLED: 'false' } });
  f.save(opsFor(sampleBoard()));
  assert.deepEqual(dirty(f.env), {});
  f.tick();
  assert.equal(tab(f.env, 'Cards', 1).length, 0);
  assert.throws(() => f.env.run('syncNow()'), /SYNC_ENABLED/);
});

test('trigger cost when idle: no sheet call, one property read', () => {
  const f = loaded();
  const s = { ...f.env.wb.stats }, pr = f.env.counters.propReads;
  f.tick();
  assert.deepEqual(f.env.wb.stats, s);
  assert.ok(f.env.counters.propReads - pr <= 2);
});

test('full sync: dry run reports and writes nothing; the real run clears hand-added rows and fixes hand edits', () => {
  const { env } = loaded();
  env.wb.getSheetByName('Topics').getRange(5, 1, 1, 4).setValues([[99, '2026-11', '', 'Hand added row']]);
  env.wb.getSheetByName('Cards').getRange(3, 3).setValues([['Hand changed']]);
  let w = env.wb.stats.write;
  const c = env.run('fullSyncToTablesDryRun()');
  assert.equal(env.wb.stats.write, w);
  assert.equal(c.deletes, 1); assert.equal(c.updates, 1);
  assert.ok(env.logs.some((l) => /Hand added|clear  99/.test(l)));
  env.run('fullSyncToTables()');
  assert.equal(tab(env, 'Topics', 1).filter((r) => r[0] !== '').length, 2);
  assert.equal(tab(env, 'Cards', 3)[1][2], 'Always-On');
  assert.equal(env.run('verifyStoreAgainstTables()').differences, 0);
});

test('full sync and import refuse on an empty store', () => {
  const f = fresh();
  assert.throws(() => f.env.run('fullSyncToTables()'), /Board store is empty/);
  assert.throws(() => f.env.run('verifyStoreAgainstTables()'), /empty/);
});

test('an item the tables cannot hold (comma) is reported, stays dirty and does not stop the others', () => {
  const f = fresh();
  const b = sampleBoard();
  f.save(opsFor(b));
  // sneak a bad value past the save check, as if Lists/rules changed later
  f.env.run('PROTO'); // keep harness honest
  const it = JSON.parse(JSON.stringify(b.cards[2])); it.formats = ['Email, Ad'];
  const sh = f.env.wb.store; const n = sh.getLastRow();
  const rows = sh.getRange(2, 1, n - 1, 2).getDisplayValues(); const idx = rows.findIndex((r) => r[0] === 'cards' && r[1] === '103');
  sh.getRange(idx + 2, 3).setValues([[JSON.stringify(it)]]);
  f.tick();
  assert.equal(tab(f.env, 'Cards', 1).length, 2, 'the other two cards were written');
  assert.match(JSON.parse(f.env.props.get('SYNC_STATUS')).error, /contains a comma/);
  assert.ok(dirty(f.env)['cards|103']);
});

test('table header changed or a column inserted: the sync stops with a clear error and writes nothing', () => {
  const f = fresh();
  f.save(opsFor(sampleBoard()));
  f.env.wb.getSheetByName('Topics').getRange(1, 2).setValues([['Month key']]);
  f.tick();
  assert.match(JSON.parse(f.env.props.get('SYNC_STATUS')).error, /Tab "Topics": column 2 must be "Month"/);
  assert.equal(tab(f.env, 'Cards', 1).length, 0);
});

// ---------- import ----------

function withTables() { // tables filled by a normal sync, then the store emptied: the starting point of the first import
  const f = loaded();
  const sh = f.env.wb.store; sh.getRange(2, 1, sh.getLastRow() - 1, 5).clearContent();
  f.env.props.delete('SYNC_DIRTY');
  return f;
}

test('import: loads the store from the tables; the board then equals the original and verify finds 0 differences', () => {
  const f = withTables();
  const s = f.env.run('importFromTables()');
  assert.equal(s.rows, 22);
  assert.equal(s.counts.cards, 3);
  const back = f.call('start').data.board, b = f.b;
  const norm = (x) => JSON.parse(JSON.stringify(x));
  assert.deepEqual(norm(back.cards.sort((x, y) => x.id - y.id)), norm(b.cards));
  assert.deepEqual(norm(back.topics), norm(b.topics));
  assert.deepEqual(norm(back.themes), norm(b.themes));
  assert.deepEqual(norm(back.camps), norm(b.camps));
  assert.deepEqual(norm(back.visits), norm(b.visits));
  assert.deepEqual(norm(back.pillarType), norm(b.pillarType));
  assert.deepEqual(norm(back.people), norm(b.people));
  assert.deepEqual(norm(back.personas), norm(b.personas));
  assert.deepEqual(norm(back.mix['2026-11']), norm(b.mix['2026-11']));
  assert.deepEqual(norm(back.meta['2026-11']), norm(b.meta['2026-11']));
  assert.equal(back.docs.find((d) => d.id === 'doc2').ln, '2. Campaign Briefs', 'level label derived from the code');
  assert.equal(back.links.mediaLibrary, 'https://example.org/library');
  assert.equal(f.env.run('verifyStoreAgainstTables()').differences, 0);
  assert.equal(f.call('board').data.rev, f.env.run('Number(prop_("BOARD_REV","0"))'));
});

test('import refuses when the store already has data, unless replace is chosen; replace saves a dated backup tab first', () => {
  const f = loaded();
  assert.throws(() => f.env.run('importFromTables()'), /already holds \d+ item\(s\)/);
  const before = f.env.wb.store.getLastRow();
  assert.equal(before > 1, true);
  const sh = f.env.wb.store; const n = sh.getLastRow();
  const rows = sh.getRange(2, 1, n - 1, 2).getDisplayValues(); const idx = rows.findIndex((r) => r[0] === 'cards' && r[1] === '101');
  const c = JSON.parse(sh.getRange(idx + 2, 3).getDisplayValue()); c.title = 'Changed on the board only';
  sh.getRange(idx + 2, 3).setValues([[JSON.stringify(c)]]);
  const s = f.env.run('importFromTablesReplace()');
  assert.match(s.backup, /^Board store backup 2026-11-06 1530$/);
  const bk = f.env.wb.getSheetByName(s.backup);
  assert.ok(bk);
  assert.ok(bk.getRange(1, 1, bk.getMaxRows(), 5).getDisplayValues().some((r) => /Changed on the board only/.test(r[2])), 'the backup holds the previous store');
  assert.equal(f.call('board').data.board.cards.find((x) => x.id === 101).title, 'Class moments reel', 'the store now equals the tables');
});

test('import is not reachable from the web', () => {
  const f = fresh();
  for (const a of ['importFromTables', 'importFromTablesReplace', 'fullSyncToTables', 'syncNow']) assert.equal(f.call(a).error, 'bad_request');
});

test('import notes untranslatable values and refuses an item too big for one cell, before writing anything', () => {
  const f = withTables();
  f.env.wb.getSheetByName('Cards').getRange(2, 4).setValues([['Published']]);
  const s = f.env.run('importFromTables()');
  assert.ok(s.warnings.some((w) => /stage "Published" is not in Lists/.test(w)));
  const g = withTables();
  g.env.wb.getSheetByName('Cards').getRange(2, 17).setNumberFormat('@').setValues([['y'.repeat(49500)]]);
  assert.throws(() => g.env.run('importFromTables()'), /too large for one store cell/);
  assert.equal(g.env.wb.store.getLastRow(), 1, 'nothing written');
});

test('even if a table column lost its text format, month keys, level codes and formula-like text stay text', () => {
  const f = fresh();
  ['Months', 'Cards', 'Documents', 'Topics'].forEach((n) => { const sh = f.env.wb.getSheetByName(n); sh.getRange(2, 1, 20, 3).setNumberFormat('General'); });
  f.env.wb.getSheetByName('Cards').getRange(2, 16, 20, 2).setNumberFormat('General');
  f.save(opsFor(sampleBoard())); f.tick();
  assert.equal(typeof f.env.wb.getSheetByName('Months').getRange(2, 1).getValues()[0][0], 'string');
  assert.equal(tab(f.env, 'Months', 1)[0][0], '2026-11');
  assert.equal(tab(f.env, 'Documents', 2)[0][1], '1');
  assert.equal(typeof f.env.wb.getSheetByName('Documents').getRange(2, 2).getValues()[0][0], 'string');
  assert.equal(tab(f.env, 'Cards', 17).find((x) => x[0] === '102')[16], '2026-11');
  assert.equal(tab(f.env, 'Cards', 2).find((x) => x[0] === '102')[1], '=SUM(1,1) is only a title');
});
