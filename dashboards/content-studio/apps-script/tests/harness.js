'use strict';
// Test harness: runs the Apps Script files (Codec.gs, Code.gs, TableSync.gs, Import.gs, SalesforceClasses.gs) in Node
// with a FAKE workbook built from the real tab names, headers, formats and capacities. It imitates the parts of Google's
// services the code uses, including the behaviour that matters for correctness: setValues() parses text like typed input
// unless the cell format is text ("2026-11" becomes a date), getDisplayValues() returns what Sheets shows, and the cache
// and property value size limits. It cannot imitate Google itself (real quotas, real latency, real permissions).

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..');
const FILES = ['Codec.gs', 'Code.gs', 'TableSync.gs', 'Import.gs', 'SalesforceClasses.gs'];

// ---------- serial numbers and display formats ----------
const pad = (n, w = 2) => String(n).padStart(w, '0');
const EPOCH = Date.UTC(1899, 11, 30);
function serialToParts(serial) {
  const ms = Math.round(EPOCH + serial * 86400000);
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
}
function display(cell) {
  const v = cell.v, f = cell.f;
  if (v === '' || v == null) return '';
  if (v && typeof v === 'object' && v.formula) return '#NAME?';
  if (f === '@') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    const p = serialToParts(v);
    if (f === 'yyyy-mm-dd') return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
    if (f === 'hh:mm') return `${pad(Math.floor(Math.round((v % 1) * 1440) / 60))}:${pad(Math.round((v % 1) * 1440) % 60)}`;
    if (f === 'yyyy-mm-dd hh:mm:ss') return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
    if (f === '0%') return Math.round(v * 100) + '%';
    if (f === '0') return v.toFixed(0);
    if (f === 'm/d/yyyy') return `${p.mo}/${p.d}/${p.y}`;
    return String(v);
  }
  return String(v);
}
// What Sheets does with text passed to setValues() when the cell is NOT formatted as plain text.
function parseTyped(s) {
  let m;
  if (s.startsWith('=')) return { v: { formula: s }, f: null };
  if (/^(true|false)$/i.test(s)) return { v: s.toLowerCase() === 'true', f: null };
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return { v: Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 + 25569, f: 'yyyy-mm-dd' };
  if ((m = /^(\d{4})-(\d{2})$/.exec(s))) return { v: Date.UTC(+m[1], +m[2] - 1, 1) / 86400000 + 25569, f: 'm/d/yyyy' };
  if (/^-?\d+(\.\d+)?$/.test(s)) return { v: Number(s), f: null };
  return null;
}

class FakeRange {
  constructor(sh, r, c, nr, nc) { this.sh = sh; this.r = r; this.c = c; this.nr = nr; this.nc = nc; }
  _each(fn) { const out = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(fn(this.sh._cell(this.r + i, this.c + j, false), this.r + i, this.c + j)); out.push(row); } return out; }
  _check() { if (this.r < 1 || this.c < 1 || this.r + this.nr - 1 > this.sh.maxRows || this.c + this.nc - 1 > this.sh.maxCols) throw new Error('Range is outside the sheet grid: ' + this.sh.name + ' r' + this.r + ' c' + this.c + ' ' + this.nr + 'x' + this.nc); }
  getValues() { this.sh.wb.stat('read'); this._check(); return this._each((x) => (x ? (x.v && x.v.formula ? x.v.formula : x.v) : '')); }
  getDisplayValues() { this.sh.wb.stat('read'); this._check(); return this._each((x) => (x ? display(x) : '')); }
  getDisplayValue() { this.sh.wb.stat('read'); return this.getDisplayValues()[0][0]; }
  getValue() { return this.getValues()[0][0]; }
  setValues(vals) {
    this.sh.wb.stat('write'); this._check();
    if (vals.length !== this.nr || vals.some((r) => r.length !== this.nc)) throw new Error('setValues: data size does not match the range');
    vals.forEach((row, i) => row.forEach((v, j) => {
      const cell = this.sh._cell(this.r + i, this.c + j, true);
      if (v instanceof Date) throw new Error('test harness: Date objects are not used by the code');
      if (typeof v === 'string' && v !== '' && cell.f !== '@') {
        const t = parseTyped(v);
        if (t) { cell.v = t.v; if (t.f) cell.f = t.f; return; }
      }
      cell.v = v;
    }));
    return this;
  }
  setNumberFormats(fs_) { this.sh.wb.stat('write'); this._check(); fs_.forEach((row, i) => row.forEach((f, j) => { this.sh._cell(this.r + i, this.c + j, true).f = f; })); return this; }
  setNumberFormat(f) { this.sh.wb.stat('write'); this._check(); this._each((x, r, c) => { this.sh._cell(r, c, true).f = f; }); return this; }
  getNumberFormats() { return this._each((x) => (x && x.f) || 'General'); }
  clearContent() { this.sh.wb.stat('write'); this._check(); this._each((x, r, c) => { if (x) x.v = ''; }); return this; }
}

class FakeSheet {
  constructor(wb, name, rows, cols, id) { this.wb = wb; this.name = name; this.maxRows = rows; this.maxCols = cols; this.cells = new Map(); this.id = id; }
  _cell(r, c, create) { const k = r * 100 + c; let x = this.cells.get(k); if (!x && create) { x = { v: '', f: null }; this.cells.set(k, x); } return x; }
  getName() { return this.name; }
  getSheetId() { return this.id; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  getLastRow() { this.wb.stat('meta'); let last = 0; this.cells.forEach((x, k) => { if (x.v !== '' && x.v != null) last = Math.max(last, Math.floor(k / 100)); }); return last; }
  getRange(r, c, nr = 1, nc = 1) { return new FakeRange(this, r, c, nr, nc); }
  insertRowsAfter(pos, n) { this.wb.stat('write'); if (pos !== this.maxRows) throw new Error('harness: only appending at the end is expected'); this.maxRows += n; }
  // test helpers
  setHeader(headers) { headers.forEach((h, i) => { this._cell(1, i + 1, true).v = h; }); }
  rowValues(r, n) { return this.getRange(r, 1, 1, n).getDisplayValues()[0]; }
}

class FakeWorkbook {
  constructor(id) { this.id = id; this.sheets = []; this.stats = { read: 0, write: 0, meta: 0 }; this.nextId = 2000000001; this.onlySheets = null; }
  stat(k) { this.stats[k]++; }
  addSheet(name, rows, cols) { const s = new FakeSheet(this, name, rows, cols, this.nextId++); this.sheets.push(s); return s; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(name) { if (this.getSheetByName(name)) throw new Error('A sheet with the name "' + name + '" already exists.'); return this.addSheet(name, 1000, 26); }
  getSheets() { return this.sheets; }
}

// Static Lists exactly as in the workbook (columns A:P), copied from the real Lists tab.
const LISTS = {
  'Stage': ['Ideas', 'Scripting', 'To capture', 'Captured', 'Editing', 'Final review', 'To be scheduled', 'Scheduled'],
  'Stage key': ['idea', 'scripting', 'tocapture', 'captured', 'editing', 'review', 'tobesched', 'scheduled'],
  'Format': ['Reel', 'Static post', 'Carousel', 'Story', 'Video', 'Email', 'Blog article', 'Ad'],
  'Platform': ['Instagram', 'Facebook', 'LinkedIn', 'TikTok', 'YouTube', 'Email', 'Website', 'Meta Ads'],
  'Content Type': ['Blog Pillar Page', 'Blog Article', 'Instagram Post', 'Instagram Carousel', 'Instagram Story', 'Instagram Reel', 'TikTok', 'YouTube Short', 'YouTube Video', 'Facebook Post', 'Facebook Story', 'LinkedIn Post', 'Email Send', 'Meta Ad', 'Portal Banner'],
  'Distribution Format': ['Organic Social', 'Email', 'Website/Blog'],
  'Mix Category': ['Educational', 'Community', 'Program/Enrollment', 'Organizational'],
  'Mix code': ['e', 'c', 'p', 'o'],
  'Pillar Type': ['social', 'blog'],
  'Topic Kind': ['Heritage', 'Civic', 'Holiday', 'Awareness day', 'Campaign', 'Other'],
  'Document Level': ['1. Marketing Plan', '2. Campaign Briefs', '2. Campaign Briefs (pending)', '3. Content Plan', '3. Content Matrix', '4. Channel Playbooks', 'Supporting'],
  'Level code': ['1', '2', '2', '3', '3', '4', 'S'],
  'Period': ['week', 'month'],
  'Yes/No': ['Yes', 'No'],
  'Document Status': ['Planned', 'Draft', 'Current/Active', 'Discontinued', 'Ended', 'Needs Update'],
  'Link Kind': ['Canva design', 'HubSpot email', 'Drive folder', 'Blog draft', 'Other']
};

// Builds the fake workbook: all 15 tabs with the real headers, formats and capacities, the Lists tab and the Board store.
function buildWorkbook(ctx, opts = {}) {
  const wb = new FakeWorkbook(opts.id || 'TEST-WORKBOOK-ID');
  const caps = Object.assign({}, opts.caps || {});
  const REAL_CAP = { cards: 2000, cardLinks: 3000, cardNotes: 3000, topics: 1000, months: 60, themes: 40, camps: 40, pillars: 40, personas: 40, people: 40, docs: 100, classes: 500, visits: 200, visitShots: 1000, settings: 50 };
  Object.keys(ctx.TB).forEach((k) => {
    const spec = ctx.TB[k], cap = caps[k] || REAL_CAP[k];
    const extra = k === 'classes' && opts.classLog ? 2 : 0;
    const sh = wb.addSheet(spec.tab, cap + 1, spec.cols.length + extra + 1);
    sh.setHeader(spec.cols.map((c) => c[0]).concat(extra ? ['SF Sync', 'SF Synced at'] : []));
    spec.cols.forEach((c, i) => sh.getRange(2, i + 1, cap, 1).setNumberFormat(ctx.TB_FORMATS[c[1]]));
    if (extra) sh.getRange(2, spec.cols.length + 1, cap, 2).setNumberFormat('@');
  });
  const lists = wb.addSheet('Lists', 60, 27);
  Object.keys(LISTS).forEach((h, i) => { lists._cell(1, i + 1, true).v = h; LISTS[h].forEach((v, r) => { lists._cell(r + 2, i + 1, true).v = v; }); });
  // formula mirrors exist on the real tab (Q:W); the code does not read them
  const store = wb.addSheet('Board store', (opts.storeRows || 5000), 5);
  store.setHeader(['collection', 'id', 'json', 'updated at', 'updated by']);
  store.getRange(2, 1, store.maxRows - 1, 5).setNumberFormat('@');
  store.getRange(2, 4, store.maxRows - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  wb.store = store;
  wb.stats = { read: 0, write: 0, meta: 0 };
  return wb;
}

function formatDate(date, tz, fmt) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t).value;
  const h24 = +g('hour'), h12 = h24 % 12 || 12;
  return fmt.replace('yyyy', g('year')).replace('MM', g('month')).replace('dd', g('day')).replace('HHmm', g('hour') + g('minute')).replace('HH', g('hour')).replace('mm', g('minute')).replace('ss', g('second'))
    .replace('h', String(h12)).replace('a', h24 >= 12 ? 'PM' : 'AM').replace('z', g('timeZoneName'));
}

function makeEnv(opts = {}) {
  const clock = { t: Date.UTC(2026, 10, 6, 20, 30, 0) }; // 2026-11-06 15:30 Eastern
  const props = new Map(Object.entries(Object.assign({ GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', STAFF_DOMAIN: 'redefinerswl.org', SHEET_ID: 'TEST-WORKBOOK-ID', SYNC_ENABLED: 'true', TEXT_FORMAT_GUARD: 'on' }, opts.props || {})));
  const counters = { propReads: 0, propWrites: 0, cacheOps: 0, fetches: [], lockCalls: 0, triggers: [] };
  const cacheMap = new Map();
  const cache = {
    get: (k) => { counters.cacheOps++; const e = cacheMap.get(k); if (!e) return null; if (e.exp && e.exp < clock.t) { cacheMap.delete(k); return null; } return e.v; },
    put: (k, v, ttl) => { counters.cacheOps++; if (String(v).length > 100000) throw new Error('Argument too large: value'); cacheMap.set(k, { v: String(v), exp: clock.t + (ttl || 600) * 1000 }); },
    putAll: (o, ttl) => Object.keys(o).forEach((k) => cache.put(k, o[k], ttl)),
    getAll: (keys) => { const out = {}; keys.forEach((k) => { const v = cache.get(k); if (v != null) out[k] = v; }); return out; },
    remove: (k) => { cacheMap.delete(k); }
  };
  const propsApi = {
    getProperty: (k) => { counters.propReads++; return props.has(k) ? props.get(k) : null; },
    setProperty: (k, v) => { counters.propWrites++; if (String(v).length > 9000) throw new Error('Argument too large: value'); props.set(k, String(v)); },
    deleteProperty: (k) => { counters.propWrites++; props.delete(k); }
  };
  const lockState = { held: false, failNext: false };
  const lock = { tryLock: () => { counters.lockCalls++; if (lockState.held || lockState.failNext) { lockState.failNext = false; return false; } lockState.held = true; return true; }, releaseLock: () => { lockState.held = false; } };
  const tokens = Object.assign({}, opts.tokens || {});
  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    Logger: { log: (m) => { env.logs.push(String(m)); } },
    CacheService: { getScriptCache: () => cache },
    PropertiesService: { getScriptProperties: () => propsApi },
    LockService: { getScriptLock: () => lock },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@redefinerswl.org' }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(s).digest()).map((b) => (b > 127 ? b - 256 : b)),
      base64Encode: (x) => Buffer.from(typeof x === 'string' ? x : Uint8Array.from(x.map((b) => (b < 0 ? b + 256 : b)))).toString('base64'),
      base64EncodeWebSafe: (x) => Buffer.from(typeof x === 'string' ? x : Uint8Array.from(x.map((b) => (b < 0 ? b + 256 : b)))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      base64Decode: (s) => Array.from(Buffer.from(s, 'base64')),
      newBlob: (data, mime) => { const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.map((b) => (b < 0 ? b + 256 : b))); return { getBytes: () => Array.from(buf), getDataAsString: () => buf.toString('utf8'), _buf: buf }; },
      gzip: (blob) => { const z = zlib.gzipSync(blob._buf); return { getBytes: () => Array.from(z), _buf: z }; },
      ungzip: (blob) => { const z = zlib.gunzipSync(blob._buf); return { getBytes: () => Array.from(z), getDataAsString: () => z.toString('utf8'), _buf: z }; },
      formatDate
    },
    UrlFetchApp: {
      fetch: (url, o) => {
        counters.fetches.push(url);
        const r = env.fetchHandler(url, o || {});
        return { getResponseCode: () => r.code, getContentText: () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
      }
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ s, setMimeType() { return this; }, getContent() { return this.s; } }) },
    ScriptApp: {
      WeekDay: {},
      newTrigger: (fn) => { const t = { fn }; const b = { timeBased: () => b, everyMinutes: () => b, atHour: (h) => { t.hour = h; return b; }, everyDays: () => b, inTimezone: (z) => { t.tz = z; return b; }, create: () => { counters.triggers.push(t); return t; } }; return b; },
      getProjectTriggers: () => counters.triggers.map((t) => ({ getHandlerFunction: () => t.fn, _t: t })),
      deleteTrigger: (x) => { const i = counters.triggers.indexOf(x._t); if (i >= 0) counters.triggers.splice(i, 1); }
    },
    SpreadsheetApp: { openById: (id) => { if (id !== env.wb.id) throw new Error('No spreadsheet with id ' + id); return env.wb; } }
  };
  const context = vm.createContext(sandbox);
  FILES.forEach((f) => vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), context, { filename: f }));
  const env = { ctx: context, props, cache, cacheMap, counters, clock, lockState, logs: [], tokens, wb: null, fetchHandler: null };
  context.nowMs_ = () => clock.t;
  env.wb = buildWorkbook(context, opts);
  env.defaultFetch = (url) => {
    const m = /tokeninfo\?id_token=(.*)$/.exec(url);
    if (m) { const t = tokens[decodeURIComponent(m[1])]; return t ? { code: 200, body: t } : { code: 400, body: { error: 'invalid_token' } }; }
    return { code: 404, body: '' };
  };
  env.fetchHandler = env.defaultFetch;
  // convenience
  env.token = (email, extra = {}) => {
    const id = 'tok-' + email + '-' + Object.keys(tokens).length;
    tokens[id] = Object.assign({ aud: 'test-client.apps.googleusercontent.com', iss: 'https://accounts.google.com', email, email_verified: 'true', hd: 'redefinerswl.org', name: email.split('@')[0], exp: String(Math.floor(clock.t / 1000) + 3000) }, extra);
    return id;
  };
  env.call = (action, body, idToken) => {
    const e = { postData: { contents: JSON.stringify(Object.assign({ action, proto: context.PROTO, idToken }, body)) } };
    return JSON.parse(context.doPost(e).getContent());
  };
  env.run = (fn) => { const r = vm.runInContext(fn, context); return r === undefined || typeof r === 'function' ? r : JSON.parse(JSON.stringify(r)); };
  return env;
}

module.exports = { makeEnv, LISTS, display, FakeWorkbook };
