'use strict';
// Tests of the Board store, validation, auth and presence (Code.gs). Run: node --test dashboards/content-studio/apps-script/tests
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./harness');
const { sampleBoard, opsFor } = require('./fixtures');

const canon = (b) => JSON.parse(JSON.stringify(b, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((o, x) => { o[x] = v[x]; return o; }, {}) : v)));
function fresh(opts) {
  const env = makeEnv(opts);
  const tok = env.token('alex@redefinerswl.org');
  const call = (action, body) => env.call(action, body, tok);
  return { env, tok, call, save: (ops) => call('save', { ops }) };
}
const sortById = (a) => a.slice().sort((x, y) => String(x.id).localeCompare(String(y.id)));

test('empty store: start returns the empty board shape and revision 0', () => {
  const { call } = fresh();
  const r = call('start');
  assert.equal(r.ok, true);
  assert.equal(r.data.rev, 0);
  assert.deepEqual(r.data.board.cards, []);
  assert.deepEqual(r.data.board.mix, {});
  assert.equal(r.data.who.name, 'alex');
});

test('save everything, read it back identical (all item kinds)', () => {
  const { call, save } = fresh();
  const b = sampleBoard();
  const r = save(opsFor(b));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.data.rejected, []);
  const back = call('board').data.board;
  for (const c of ['cards', 'camps', 'themes', 'topics', 'docs', 'visits']) assert.deepEqual(canon(sortById(back[c])), canon(sortById(b[c])), c);
  assert.deepEqual(canon(back.mix), canon(b.mix));
  assert.deepEqual(canon(back.meta), canon(b.meta));
  for (const k of ['people', 'pillars', 'pillarType', 'personas', 'texts', 'links']) assert.deepEqual(canon(back[k]), canon(b[k]), k);
});

test('month keys and numeric-looking ids stay text in the store, even if the column lost its text format', () => {
  const { env, save, call } = fresh();
  env.wb.store.getRange(2, 1, 100, 2).setNumberFormat('General'); // simulate a hand-changed format
  const r = save([{ c: 'mix', id: '2026-11', v: { e: 10, c: 20, p: 30, o: 40, lock: [], camps: '', why: '' } }, { c: 'meta', id: '2026-11', v: { theme: 'T', camps: [], mtcamps: '' } }]);
  assert.equal(r.ok, true);
  const cell = env.wb.store.getRange(2, 2).getValues()[0][0];
  assert.equal(typeof cell, 'string');
  assert.equal(cell, '2026-11');
  assert.deepEqual(Object.keys(call('board').data.board.mix), ['2026-11']);
});

test('a save that changes nothing writes nothing and keeps the revision', () => {
  const { env, save } = fresh();
  const ops = opsFor(sampleBoard());
  const first = save(ops).data;
  const w = env.wb.stats.write;
  const second = save(ops).data;
  assert.equal(second.applied, 0);
  assert.equal(second.rev, first.rev);
  assert.equal(env.wb.stats.write, w);
});

test('two editors on different cards never overwrite each other; same card: later save wins', () => {
  const { env, save, call } = fresh();
  const b = sampleBoard();
  save(opsFor(b));
  const tok2 = env.token('sam@redefinerswl.org');
  const a = JSON.parse(JSON.stringify(b.cards[0])), c = JSON.parse(JSON.stringify(b.cards[2]));
  a.title = 'Edited by Alex'; c.title = 'Edited by Sam';
  assert.equal(env.call('save', { ops: [{ c: 'cards', id: '101', v: a }] }, env.token('alex@redefinerswl.org')).ok, true);
  assert.equal(env.call('save', { ops: [{ c: 'cards', id: '103', v: c }] }, tok2).ok, true);
  let cards = call('board').data.board.cards;
  assert.equal(cards.find((x) => x.id === 101).title, 'Edited by Alex');
  assert.equal(cards.find((x) => x.id === 103).title, 'Edited by Sam');
  const a2 = Object.assign({}, a, { title: 'Alex again' }), a3 = Object.assign({}, a, { title: 'Sam wins' });
  env.call('save', { ops: [{ c: 'cards', id: '101', v: a2 }] }, env.token('alex@redefinerswl.org'));
  env.call('save', { ops: [{ c: 'cards', id: '101', v: a3 }] }, tok2);
  cards = call('board').data.board.cards;
  assert.equal(cards.find((x) => x.id === 101).title, 'Sam wins');
  assert.equal(cards.length, 3);
});

test('updated by is the signed-in work email and updated at a real date-time', () => {
  const { env, save } = fresh();
  save(opsFor(sampleBoard()));
  const row = env.wb.store.getRange(2, 1, 1, 5).getDisplayValues()[0];
  assert.equal(row[4], 'alex@redefinerswl.org');
  assert.match(row[3], /^2026-11-06 15:30:00$/);
  assert.equal(typeof env.wb.store.getRange(2, 4).getValues()[0][0], 'number');
});

test('Lists validation: a value not in Lists is refused with a clear message, other items still save', () => {
  const { save, call } = fresh();
  const b = sampleBoard();
  save(opsFor(b));
  const bad = JSON.parse(JSON.stringify(b.cards[0])); bad.camp = 'Made-up campaign'; bad.title = 'Should not save';
  const good = JSON.parse(JSON.stringify(b.cards[2])); good.title = 'Good edit';
  const r = save([{ c: 'cards', id: '101', v: bad }, { c: 'cards', id: '103', v: good }]);
  assert.equal(r.ok, true);
  assert.equal(r.data.rejected.length, 1);
  assert.match(r.data.rejected[0].message, /Campaign "Made-up campaign" is not in the Campaigns list/);
  assert.equal(r.data.rejected[0].error, 'bad_value');
  const cards = call('board').data.board.cards;
  assert.equal(cards.find((x) => x.id === 101).title, 'Class moments reel');
  assert.equal(cards.find((x) => x.id === 103).title, 'Good edit');
  const kinds = [['formats', ['Reel', 'Nope']], ['plats', ['Myspace']], ['pers', ['Ghost Persona']], ['status', 'published'], ['owner', 'Nobody'], ['visit', 'v99'], ['mix', 'x'], ['theme', 'nothing'], ['pillar', 'No pillar']];
  kinds.forEach(([f, v]) => {
    const c = JSON.parse(JSON.stringify(b.cards[0])); c[f] = v;
    const rr = save([{ c: 'cards', id: '101', v: c }]).data;
    assert.equal(rr.rejected.length, 1, f);
    assert.equal(rr.rejected[0].error, 'bad_value', f);
  });
  const lk = JSON.parse(JSON.stringify(b.cards[0])); lk.links[0].k = 'Fax'; assert.equal(save([{ c: 'cards', id: '101', v: lk }]).data.rejected.length, 1);
  const tp = { id: 9, m: '2026-13', date: '', label: 'x', kind: 'Nope' }; assert.equal(save([{ c: 'topics', id: '9', v: tp }]).data.rejected.length, 1);
});

test('a value that is unchanged is not checked again (a removed list value never blocks other edits)', () => {
  const { env, save } = fresh();
  const b = sampleBoard();
  save(opsFor(b));
  // the campaign is removed from the store while a card still names it
  assert.equal(save([{ c: 'camps', id: 'camp1', del: true }]).data.rejected.length, 0);
  const c = JSON.parse(JSON.stringify(b.cards[0])); c.title = 'Renamed card';
  const r = save([{ c: 'cards', id: '101', v: c }]).data;
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  const c2 = JSON.parse(JSON.stringify(c)); c2.camp = 'Gone again';
  assert.equal(save([{ c: 'cards', id: '101', v: c2 }]).data.rejected.length, 1);
});

test('new campaign, person and pillar used in the same save validate together', () => {
  const { save, call } = fresh();
  const b = sampleBoard();
  save(opsFor(b));
  const c = JSON.parse(JSON.stringify(b.cards[0]));
  c.camp = 'Brand new'; c.owner = 'New Person'; c.pillar = 'New Pillar';
  const r = save([
    { c: 'cards', id: '101', v: c },
    { c: 'camps', id: 'camp9', v: { id: 'camp9', n: 'Brand new', c: '#112233', cta: '', tags: '' } },
    { c: 'single', id: 'people', v: [...b.people, 'New Person'] },
    { c: 'single', id: 'pillars', v: [...b.pillars, 'New Pillar'] }
  ]).data;
  assert.deepEqual(r.rejected, []);
  assert.equal(call('board').data.board.cards.find((x) => x.id === 101).camp, 'Brand new');
});

test('commas are refused in multi-value fields and in names, with a clear message', () => {
  const { save } = fresh();
  const b = sampleBoard();
  save(opsFor(b));
  const c = JSON.parse(JSON.stringify(b.cards[0])); c.formats = ['Reel, Story'];
  let r = save([{ c: 'cards', id: '101', v: c }]).data;
  assert.match(r.rejected[0].message, /contains a comma/);
  r = save([{ c: 'camps', id: 'camp8', v: { id: 'camp8', n: 'A, B', c: '', cta: '', tags: '' } }]).data;
  assert.match(r.rejected[0].message, /contains a comma/);
  r = save([{ c: 'single', id: 'pillars', v: ['Fine', 'Not, fine'] }]).data;
  assert.match(r.rejected[0].message, /contains a comma/);
  r = save([{ c: 'single', id: 'personas', v: [['A, B', 'role']] }]).data;
  assert.match(r.rejected[0].message, /contains a comma/);
});

test('49,000 character guard: names the card; a 40,000 character caption saves', () => {
  const { save, call } = fresh();
  const b = sampleBoard();
  save(opsFor(b));
  const c = JSON.parse(JSON.stringify(b.cards[0]));
  c.caption = 'x'.repeat(49001);
  let r = save([{ c: 'cards', id: '101', v: c }]).data;
  assert.equal(r.rejected[0].error, 'too_big');
  assert.match(r.rejected[0].message, /Class moments reel/);
  assert.match(r.rejected[0].message, /caption/);
  c.caption = 'x'.repeat(40000);
  r = save([{ c: 'cards', id: '101', v: c }]).data;
  assert.deepEqual(r.rejected, []);
  assert.equal(call('board').data.board.cards.find((x) => x.id === 101).caption.length, 40000);
  c.caption = 'x'.repeat(48990); // each field fits, the whole JSON does not
  r = save([{ c: 'cards', id: '101', v: c }]).data;
  assert.equal(r.rejected[0].error, 'too_big');
  assert.match(r.rejected[0].message, /too large to save/);
});

test('a deleted card loses its row and the next new item reuses that row (rows never shift)', () => {
  const { env, save } = fresh();
  const b = sampleBoard();
  save(opsFor(b));
  const rows = () => { const n = env.wb.store.getLastRow(); return env.wb.store.getRange(2, 1, n - 1, 2).getDisplayValues(); };
  const before = rows();
  const idx = before.findIndex((r) => r[0] === 'cards' && r[1] === '102');
  save([{ c: 'cards', id: '102', del: true }]);
  assert.deepEqual(rows()[idx], ['', '']);
  assert.deepEqual(rows().filter((r, i) => i !== idx), before.filter((r, i) => i !== idx));
  const nc = JSON.parse(JSON.stringify(b.cards[1])); nc.id = 555;
  save([{ c: 'cards', id: '555', v: nc }]);
  assert.deepEqual(rows()[idx], ['cards', '555']);
  assert.equal(rows().length, before.length);
});

test('auto-grow: the Board store adds rows near capacity and a full tab at the hard limit fails clearly', () => {
  const { env, save } = fresh({ storeRows: 12 });
  const items = [];
  for (let i = 1; i <= 30; i++) items.push({ c: 'topics', id: String(i), v: { id: i, m: '2026-11', date: '', label: 'T' + i, kind: '' } });
  const r = save(items);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(env.wb.store.getMaxRows() > 30, 'grew to ' + env.wb.store.getMaxRows());
  assert.equal(env.run('KEYED.length') > 0, true);
  const rr = fresh({ storeRows: 5 });
  rr.env.run('STORE_MAX_ROWS = 6');
  const r2 = rr.save([1, 2, 3, 4, 5, 6, 7].map((i) => ({ c: 'topics', id: String(i), v: { id: i, m: '2026-11', date: '', label: 'x', kind: '' } })));
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'full');
  assert.match(r2.message, /full/);
});

test('heartbeat and leave never touch a spreadsheet; they report the revision', () => {
  const { env, call, save } = fresh();
  save(opsFor(sampleBoard()));
  const s = { ...env.wb.stats };
  const props = env.counters.propWrites;
  for (let i = 0; i < 10; i++) {
    const r = call('heartbeat', { view: 'ideas' });
    assert.equal(r.ok, true);
    assert.equal(r.data.people.length, 1);
    assert.equal(r.data.people[0].self, true);
    assert.equal(r.data.rev, 1);
  }
  call('leave');
  assert.deepEqual(env.wb.stats, s);
  assert.equal(env.counters.propWrites, props);
  assert.equal(call('heartbeat', { view: 'x' }).data.people.length, 1);
  assert.equal(env.counters.fetches.length, 1, 'only one tokeninfo call, then the sign-in check is cached');
});

test('presence: two people, expiry after 45 seconds', () => {
  const { env, call } = fresh();
  call('heartbeat', { view: 'a' });
  const t2 = env.token('sam@redefinerswl.org');
  const r = env.call('heartbeat', { view: 'b' }, t2);
  assert.equal(r.data.people.length, 2);
  env.clock.t += 50000;
  assert.equal(env.call('heartbeat', { view: 'b' }, t2).data.people.length, 1);
});

test('sign-in failures', () => {
  const { env, save } = fresh();
  const bad = (token, code) => { const r = env.call('start', {}, token); assert.equal(r.ok, false); assert.equal(r.error, code, JSON.stringify(r)); return r; };
  bad(undefined, 'sign_in_required');
  bad('not-a-token', 'sign_in_required');
  bad(env.token('x@gmail.com', { hd: undefined }), 'not_staff');
  bad(env.token('x@other.org', { hd: 'other.org' }), 'not_staff');
  bad(env.token('x@redefinerswl.org', { aud: 'someone-else' }), 'not_staff');
  bad(env.token('x@redefinerswl.org', { email_verified: 'false' }), 'not_staff');
  bad(env.token('x@redefinerswl.org', { exp: '1' }), 'not_staff');
  bad(env.token('x@redefinerswl.org', { iss: 'https://evil.example' }), 'not_staff');
  const nosave = env.call('save', { ops: [{ c: 'cards', id: '1', v: {} }] }, 'nope');
  assert.equal(nosave.ok, false);
  assert.equal(env.wb.store.getLastRow(), 1, 'nothing written');
  const r = env.call('start', { proto: 1 }, env.token('ok@redefinerswl.org'));
  assert.equal(r.error, 'outdated');
  assert.equal(env.call('wipe', {}, env.token('ok2@redefinerswl.org')).error, 'bad_request');
  assert.equal(JSON.parse(env.ctx.doPost({ postData: { contents: '{nope' } }).getContent()).error, 'bad_request');
  assert.equal(JSON.parse(env.ctx.doGet().getContent()).ok, true);
  void save;
});

test('a busy lock answers busy, not a crash; classes cannot be changed from the web', () => {
  const { env, save } = fresh();
  env.lockState.failNext = true;
  assert.equal(save([{ c: 'topics', id: '1', v: { id: 1, m: '2026-11', date: '', label: 'x', kind: '' } }]).error, 'busy');
  const r = save([{ c: 'classes', id: '1', v: { id: 1 } }]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad_request');
  assert.match(r.message, /Salesforce/);
  assert.equal(save([{ c: 'nope', id: '1', v: {} }]).error, 'bad_request');
  assert.equal(save(new Array(301).fill({ c: 'topics', id: '1', v: {} })).error, 'bad_request');
});

test('board reads are cached per revision (several boards reloading cost one sheet read)', () => {
  const { env, call, save } = fresh();
  save(opsFor(sampleBoard()));
  call('board');
  const reads = env.wb.stats.read;
  call('board'); call('board'); call('start');
  assert.equal(env.wb.stats.read, reads);
  save([{ c: 'topics', id: '7', v: { id: 7, m: '2026-11', date: '', label: 'new', kind: '' } }]);
  const r = call('board');
  assert.ok(env.wb.stats.read > reads);
  assert.equal(r.data.board.topics.length, 3);
});

test('quota: a one-card save makes few calls', () => {
  const { env, save } = fresh();
  const b = sampleBoard();
  save(opsFor(b));
  const c = JSON.parse(JSON.stringify(b.cards[0])); c.title = 'x';
  const before = { ...env.wb.stats };
  save([{ c: 'cards', id: '101', v: c }]);
  const reads = env.wb.stats.read - before.read, writes = env.wb.stats.write - before.write;
  assert.ok(reads <= 2, 'reads ' + reads);
  assert.ok(writes <= 3, 'writes ' + writes);
});

test('setup(): passes on the real layout, refuses on a changed header or a missing property', () => {
  const { env } = fresh();
  env.run('setup()');
  assert.ok(env.logs.some((l) => /^Ready\./.test(l)));
  env.wb.getSheetByName('Cards').getRange(1, 3).setValues([['Campaign name']]);
  assert.throws(() => env.run('setup()'), /Tab "Cards": column 3 must be "Campaign" but is "Campaign name"/);
  const e2 = makeEnv({ props: { SHEET_ID: '' } });
  assert.throws(() => e2.run('setup()'), /Missing Script Property: SHEET_ID/);
  const e3 = makeEnv();
  e3.wb.store.getRange(1, 3).setValues([['data']]);
  assert.throws(() => e3.run('setup()'), /Row 1 of "Board store" must read/);
});

test('start and board also send the Lists tab values so the page dropdowns follow the workbook', () => {
  const { call } = fresh();
  const r = call('start').data;
  assert.deepEqual(r.lists.stage.slice(0, 3), ['Ideas', 'Scripting', 'To capture']);
  assert.deepEqual(r.lists.dstatus, ['Planned', 'Draft', 'Current/Active', 'Discontinued', 'Ended', 'Needs Update']);
  assert.equal(call('board').data.lists.format.length, 8);
});
