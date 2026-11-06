// Content Studio board: the typed tables of the "Content Studio Data" workbook (layout, cell codec, and the codec
// between board items and table rows). Nothing private lives in this file.
//
// The board's master store is the "Board store" tab (Code.gs). The typed tables below are a ONE-WAY mirror of it
// (TableSync.gs). They are read only by the one-time import (Import.gs) and by the verify function.
//
// Table rules (BOARD-DATA-MODEL.md of the workbook): row 1 = header, data from row 2, key = column A, every table ends
// with "Updated at" (date-time) and "Updated by" (text). The first N columns must be exactly the headers below, in
// this order; a person may add columns to the RIGHT of "Updated by" only (the script never touches them, except the two
// optional Salesforce log columns of Classes).

var TB_TZ = 'America/New_York';
var TB_STAMP = [['Updated at', 'datetime'], ['Updated by', 'text']];
var TB_CELL_MAX = 49000; // Google's limit is 50,000 characters per cell

// Column types: int, text, long (long text), date (yyyy-mm-dd), time (HH:MM), pct (0 to 100), datetime.
var TB = {
  cards: { tab: 'Cards', max: 20000, cols: [['ID', 'int'], ['Title', 'text'], ['Campaign', 'text'], ['Stage', 'text'], ['Owner', 'text'], ['Post Date', 'date'], ['Post Time', 'time'], ['Formats', 'text'], ['Platforms', 'text'], ['Goal', 'long'], ['Audience', 'text'], ['CTA', 'text'], ['Questions', 'long'], ['Voiceover', 'long'], ['Needs', 'long'], ['Visit', 'text'], ['Caption', 'long'], ['Spanish Caption', 'long'], ['Hashtags', 'text'], ['Mix Category', 'text'], ['Content Theme', 'text'], ['Pillar', 'text']] },
  cardLinks: { tab: 'Card links', max: 20000, parent: 'Card ID', cols: [['ID', 'text'], ['Card ID', 'int'], ['Kind', 'text'], ['Title', 'text'], ['URL', 'text']] },
  cardNotes: { tab: 'Card notes', max: 20000, parent: 'Card ID', cols: [['ID', 'text'], ['Card ID', 'int'], ['Author', 'text'], ['Note', 'long']] },
  topics: { tab: 'Topics', max: 5000, cols: [['ID', 'int'], ['Month', 'text'], ['Date', 'date'], ['Label', 'long'], ['Kind', 'text']] },
  months: { tab: 'Months', max: 240, cols: [['Month', 'text'], ['Theme', 'text'], ['Campaigns (mix text)', 'long'], ['Campaigns (topics text)', 'long'], ['Campaign list', 'text'], ['Educational %', 'pct'], ['Community %', 'pct'], ['Program/Enrollment %', 'pct'], ['Organizational %', 'pct'], ['Locked', 'text'], ['Why this mix', 'long']] },
  themes: { tab: 'Themes', max: 200, cols: [['ID', 'text'], ['Theme', 'text'], ['What it covers', 'long'], ['Home pillars', 'text'], ['Minimum frequency', 'text'], ['Count', 'int'], ['Per', 'text'], ['In use', 'text']] },
  camps: { tab: 'Campaigns', max: 200, cols: [['ID', 'text'], ['Campaign', 'text'], ['Colour', 'text'], ['CTA', 'text'], ['Hashtags', 'text']] },
  pillars: { tab: 'Pillars', max: 200, cols: [['Pillar', 'text'], ['Type', 'text']] },
  personas: { tab: 'Personas', max: 200, cols: [['Persona', 'text'], ['Role', 'text']] },
  people: { tab: 'People', max: 200, cols: [['Person', 'text']] },
  docs: { tab: 'Documents', max: 1000, cols: [['ID', 'text'], ['Level', 'text'], ['Level label', 'text'], ['Document', 'text'], ['Answers', 'text'], ['Status', 'text'], ['Link', 'text']] },
  classes: { tab: 'Classes', max: 5000, cols: [['ID', 'int'], ['Program', 'text'], ['Class', 'text'], ['Site', 'text'], ['Day', 'int'], ['Time', 'time'], ['Audience', 'text'], ['End date', 'date'], ['End note', 'text'], ['Enrolled', 'int'], ['Attended', 'int'], ['n', 'int']] },
  visits: { tab: 'Visits', max: 2000, cols: [['ID', 'text'], ['Date', 'date'], ['Site', 'text'], ['Who', 'text'], ['Class IDs', 'text']] },
  visitShots: { tab: 'Visit shots', max: 10000, parent: 'Visit ID', cols: [['ID', 'text'], ['Visit ID', 'text'], ['Shot', 'text'], ['Class ID', 'int'], ['Done', 'text']] },
  settings: { tab: 'Settings', max: 200, cols: [['Key', 'text'], ['Value', 'long']] }
};
TB.classes.optional = [['SF Sync', 'text'], ['SF Synced at', 'text']]; // optional log columns right after "Updated by" (Salesforce sync result and time)
Object.keys(TB).forEach(function (k) { TB[k].cols = TB[k].cols.concat(TB_STAMP); TB[k].key = TB[k].cols[0][0]; TB[k].name = k; });
var TB_FORMATS = { int: '0', text: '@', long: '@', date: 'yyyy-mm-dd', time: 'hh:mm', pct: '0%', datetime: 'yyyy-mm-dd hh:mm:ss' };
var TB_TEXT_SETTINGS = ['banner', 'syncNote', 'gepNote'];
var TB_LINK_SETTINGS = ['mediaLibrary'];

// ---------- cell codec (display string <-> board value <-> cell value) ----------

function tb_pad_(n) { return (n < 10 ? '0' : '') + n; }

// Cell display string -> value in the "decoded" domain (int as number or '', pct as 0..100, date 'yyyy-mm-dd', time 'HH:MM').
function tb_decodeCell_(type, s, warn) {
  s = s == null ? '' : String(s);
  if (type === 'text' || type === 'long' || type === 'datetime') return s;
  s = s.trim();
  if (s === '') return '';
  var m;
  if (type === 'int') {
    var n = Number(s.replace(/,/g, ''));
    if (isFinite(n)) return n;
    if (warn) warn('not a number: ' + s);
    return '';
  }
  if (type === 'date') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    if (warn) warn('not a date (yyyy-mm-dd): ' + s);
    return '';
  }
  if (type === 'time') {
    m = /^(\d{1,2}):(\d{2})/.exec(s);
    if (m) return tb_pad_(+m[1]) + ':' + m[2];
    if (warn) warn('not a time (hh:mm): ' + s);
    return '';
  }
  if (type === 'pct') {
    var p = parseFloat(s.replace(/,/g, ''));
    if (!isFinite(p)) { if (warn) warn('not a percent: ' + s); return ''; }
    return Math.round(s.indexOf('%') >= 0 ? p : p * 100);
  }
  return s;
}

function tb_dateSerial_(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 + 25569; }
function tb_timeFraction_(s) { var m = /^(\d{1,2}):(\d{2})$/.exec(s); return (+m[1] * 60 + +m[2]) / 1440; }
// "2026-11-06 15:30:00" (Eastern wall clock) -> serial number
function tb_dtSerial_(s) {
  var m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return '';
  return tb_dateSerial_(m[1]) + (+m[2] * 3600 + +m[3] * 60 + +m[4]) / 86400;
}
function tb_nowText_(ms) { return Utilities.formatDate(new Date(ms), TB_TZ, 'yyyy-MM-dd HH:mm:ss'); }

// Decoded value -> value written to the cell.
function tb_encodeCell_(type, v) {
  if (v == null || v === '') return '';
  if (type === 'int') return Number(v);
  if (type === 'date') return tb_dateSerial_(String(v));
  if (type === 'time') return tb_timeFraction_(String(v));
  if (type === 'pct') return Number(v) / 100;
  if (type === 'datetime') return typeof v === 'number' ? v : tb_dtSerial_(v);
  return String(v);
}

// A text cell that Sheets could mistake for a number, date, formula or boolean when it is typed in.
function tb_risky_(v) { return typeof v === 'string' && v !== '' && /^[\d=+\-@'.]|^(true|false)$/i.test(v); }

function tb_userError_(code, message) { var e = new Error(message); e.userCode = code; return e; }

// Multi-value cells: ", " between values; a value may not contain a comma.
function tb_join_(arr, what) {
  var a = Array.isArray(arr) ? arr : (arr == null || arr === '' ? [] : [arr]);
  return a.map(function (x) {
    x = String(x).trim();
    if (x.indexOf(',') >= 0) throw tb_userError_('bad_value', what + ': "' + x + '" contains a comma. Values in one table cell are kept apart by commas, so a value cannot contain one. Remove the comma.');
    return x;
  }).filter(function (x) { return x !== ''; }).join(', ');
}
function tb_split_(s) { return String(s == null ? '' : s).split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x !== ''; }); }
function tb_str_(v) { return v == null ? '' : String(v); }
function tb_int_(v) { if (v == null || v === '' || v === false) return ''; var n = Number(v); return isFinite(n) ? Math.round(n) : ''; }

// ---------- Lists tab (static dropdown values) ----------

var TB_LIST_HEADERS = {
  stage: 'Stage', stagekey: 'Stage key', format: 'Format', platform: 'Platform', mix: 'Mix Category', mixcode: 'Mix code',
  ptype: 'Pillar Type', tkind: 'Topic Kind', dlevel: 'Document Level', lcode: 'Level code', period: 'Period', yesno: 'Yes/No',
  dstatus: 'Document Status', lkind: 'Link Kind'
};

// Parses the Lists display grid (row 1 = names). The FIRST column with a given header wins (Format and Platform appear twice).
function tb_parseLists_(grid) {
  var out = {}, head = (grid[0] || []).map(function (h) { return String(h).trim(); });
  Object.keys(TB_LIST_HEADERS).forEach(function (k) {
    var c = head.indexOf(TB_LIST_HEADERS[k]);
    if (c < 0) throw tb_userError_('not_set_up', 'The Lists tab has no column "' + TB_LIST_HEADERS[k] + '" in row 1.');
    var vals = [];
    for (var r = 1; r < grid.length; r++) { var v = String(grid[r][c] == null ? '' : grid[r][c]).trim(); if (v !== '' && v.charAt(0) !== '#') vals.push(v); }
    out[k] = vals;
  });
  return out;
}

// ---------- board item -> table rows (forward) ----------
// ctx = { lists: parsed static lists, themeName: {themeId: name} }. Result: { tabKey: [rowObject, ...] }, keys in column A.

function tb_stampFor_(rec) { return { 'Updated at': rec && rec.at ? rec.at : '', 'Updated by': rec && rec.by ? rec.by : '' }; }
function tb_with(row, rec) { var s = tb_stampFor_(rec); row['Updated at'] = s['Updated at']; row['Updated by'] = s['Updated by']; return row; }

function tb_stageLabel_(ctx, key) {
  var i = ctx.lists.stagekey.indexOf(key);
  return i >= 0 ? ctx.lists.stage[i] : '';
}
function tb_mixName_(ctx, code) { var i = ctx.lists.mixcode.indexOf(code); return i >= 0 ? ctx.lists.mix[i] : ''; }
function tb_levelLabel_(ctx, code) { var i = ctx.lists.lcode.indexOf(code); return i >= 0 ? ctx.lists.dlevel[i] : ''; }

var TB_FORWARD = {
  cards: function (id, c, ctx, rec) {
    var out = { cards: [], cardLinks: [], cardNotes: [] }, lab = 'Card ' + id;
    out.cards.push(tb_with({
      'ID': tb_int_(id), 'Title': tb_str_(c.title), 'Campaign': tb_str_(c.camp), 'Stage': tb_stageLabel_(ctx, c.status),
      'Owner': tb_str_(c.owner), 'Post Date': tb_str_(c.post), 'Post Time': tb_str_(c.time),
      'Formats': tb_join_(c.formats, lab + ', Formats'), 'Platforms': tb_join_(c.plats, lab + ', Platforms'),
      'Goal': tb_str_(c.goal), 'Audience': tb_join_(c.pers, lab + ', Audience'), 'CTA': tb_str_(c.cta),
      'Questions': tb_str_(c.questions), 'Voiceover': tb_str_(c.vo), 'Needs': tb_str_(c.need), 'Visit': tb_str_(c.visit),
      'Caption': tb_str_(c.caption), 'Spanish Caption': tb_str_(c.capEs), 'Hashtags': tb_str_(c.tags),
      'Mix Category': tb_mixName_(ctx, c.mix), 'Content Theme': c.theme ? (ctx.themeName[c.theme] || '') : '', 'Pillar': tb_str_(c.pillar)
    }, rec));
    (c.links || []).forEach(function (l, i) {
      out.cardLinks.push(tb_with({ 'ID': id + '-L' + (i + 1), 'Card ID': tb_int_(id), 'Kind': tb_str_(l.k), 'Title': tb_str_(l.t), 'URL': tb_str_(l.u) }, rec));
    });
    (c.notes || []).forEach(function (n, i) {
      out.cardNotes.push(tb_with({ 'ID': id + '-N' + (i + 1), 'Card ID': tb_int_(id), 'Author': tb_str_(n && n[0]), 'Note': tb_str_(n && n[1]) }, rec));
    });
    return out;
  },
  topics: function (id, t, ctx, rec) {
    return { topics: [tb_with({ 'ID': tb_int_(id), 'Month': tb_str_(t.m), 'Date': tb_str_(t.date), 'Label': tb_str_(t.label), 'Kind': tb_str_(t.kind) }, rec)] };
  },
  // mix + meta of one month key -> ONE Months row. parts = { mix, meta } (either may be missing)
  months: function (m, parts, ctx, rec) {
    var mix = parts.mix || {}, meta = parts.meta || {}, lab = 'Month ' + m;
    var sum = (+mix.e || 0) + (+mix.c || 0) + (+mix.p || 0) + (+mix.o || 0);
    var pc = function (v) { return sum === 0 ? '' : tb_int_(v || 0); };
    return { months: [tb_with({
      'Month': m, 'Theme': tb_str_(meta.theme), 'Campaigns (mix text)': tb_str_(mix.camps), 'Campaigns (topics text)': tb_str_(meta.mtcamps),
      'Campaign list': tb_join_(meta.camps, lab + ', Campaign list'), 'Educational %': pc(mix.e), 'Community %': pc(mix.c),
      'Program/Enrollment %': pc(mix.p), 'Organizational %': pc(mix.o), 'Locked': tb_join_(mix.lock, lab + ', Locked'), 'Why this mix': tb_str_(mix.why)
    }, rec)] };
  },
  themes: function (id, t, ctx, rec) {
    return { themes: [tb_with({
      'ID': tb_str_(id), 'Theme': tb_str_(t.n), 'What it covers': tb_str_(t.cov), 'Home pillars': tb_join_(t.pil, 'Theme ' + id + ', Home pillars'),
      'Minimum frequency': tb_str_(t.freq), 'Count': tb_int_(t.fn), 'Per': tb_str_(t.fp), 'In use': t.off ? 'No' : 'Yes'
    }, rec)] };
  },
  camps: function (id, c, ctx, rec) {
    return { camps: [tb_with({ 'ID': tb_str_(id), 'Campaign': tb_str_(c.n), 'Colour': tb_str_(c.c), 'CTA': tb_str_(c.cta), 'Hashtags': tb_str_(c.tags) }, rec)] };
  },
  docs: function (id, d, ctx, rec) {
    var ln = d.ln ? String(d.ln) : tb_levelLabel_(ctx, tb_str_(d.l));
    return { docs: [tb_with({ 'ID': tb_str_(id), 'Level': tb_str_(d.l), 'Level label': ln, 'Document': tb_str_(d.n), 'Answers': tb_str_(d.a), 'Status': tb_str_(d.s), 'Link': tb_str_(d.u) }, rec)] };
  },
  classes: function (id, c, ctx, rec) {
    return { classes: [tb_with({
      'ID': tb_int_(id), 'Program': tb_str_(c.prog), 'Class': tb_str_(c.name), 'Site': tb_str_(c.site), 'Day': tb_int_(c.day), 'Time': tb_str_(c.time),
      'Audience': tb_str_(c.aud), 'End date': tb_str_(c.end), 'End note': tb_str_(c.endTxt), 'Enrolled': tb_int_(c.enr), 'Attended': tb_int_(c.att), 'n': tb_int_(c.n),
      'SF Sync': tb_str_(c.sfRes), 'SF Synced at': tb_str_(c.sfAt)
    }, rec)] };
  },
  visits: function (id, v, ctx, rec) {
    var out = { visits: [], visitShots: [] };
    out.visits.push(tb_with({ 'ID': tb_str_(id), 'Date': tb_str_(v.date), 'Site': tb_str_(v.site), 'Who': tb_str_(v.who), 'Class IDs': tb_join_(v.cls, 'Visit ' + id + ', Class IDs') }, rec));
    (v.shots || []).forEach(function (s, i) {
      out.visitShots.push(tb_with({ 'ID': id + '-S' + (i + 1), 'Visit ID': tb_str_(id), 'Shot': tb_str_(s && s.t), 'Class ID': tb_int_(s && s.k), 'Done': s && s.d ? 'Yes' : 'No' }, rec));
    });
    return out;
  }
};

// Whole-table units (the board keeps these as one document each).
// docs = { people, pillars, pillarType, personas, texts, links } plus stamps recs = { people: rec, ... }
function tb_forwardPillars_(doc, recs) {
  var rec = tb_latest_([recs.pillars, recs.pillarType]), types = doc.pillarType || {};
  return (doc.pillars || []).map(function (p) { return tb_with({ 'Pillar': tb_noComma_(p, 'Pillar name'), 'Type': tb_str_(types[p]) }, rec); });
}
function tb_forwardPersonas_(doc, recs) {
  return (doc.personas || []).filter(function (p) { return Array.isArray(p) && p[0]; })
    .map(function (p) { return tb_with({ 'Persona': tb_noComma_(p[0], 'Persona name'), 'Role': tb_str_(p[1]) }, recs.personas); });
}
function tb_forwardPeople_(doc, recs) {
  return (doc.people || []).filter(function (p) { return p; }).map(function (p) { return tb_with({ 'Person': tb_str_(p) }, recs.people); });
}
function tb_forwardSettings_(doc, recs) {
  var rows = [];
  [['texts', recs.texts], ['links', recs.links]].forEach(function (g) {
    var obj = doc[g[0]] || {};
    Object.keys(obj).forEach(function (k) { rows.push(tb_with({ 'Key': k, 'Value': tb_str_(obj[k]) }, g[1])); });
  });
  return rows;
}
function tb_noComma_(v, what) {
  v = tb_str_(v).trim();
  if (v.indexOf(',') >= 0) throw tb_userError_('bad_value', what + ' "' + v + '" contains a comma. Names are kept apart by commas in the tables, so a name cannot contain one.');
  return v;
}
function tb_latest_(recs) {
  var best = null;
  recs.forEach(function (r) { if (r && (!best || String(r.at) > String(best.at))) best = r; });
  return best;
}

// ---------- table rows -> board items (reverse; used by the import only) ----------
// tables = { tabKey: [rowObject, ...] } (decoded domain). Returns { board: {...}, warnings: [...] }.

function tb_reverse_(tables, ctx) {
  var warnings = [], board = { cards: [], camps: [], themes: [], topics: [], docs: [], classes: [], visits: [], mix: {}, meta: {}, people: [], pillars: [], pillarType: {}, personas: [], texts: {}, links: {} };
  var rows = function (k) { return tables[k] || []; };
  var themeIdByName = {};
  rows('themes').forEach(function (r) { themeIdByName[r['Theme']] = r['ID']; });
  var num = function (id) { var m = /(\d+)$/.exec(String(id)); return m ? +m[1] : 0; };
  var childrenOf = function (tab, pcol) {
    var g = {};
    rows(tab).forEach(function (r) { var p = String(r[pcol]); (g[p] = g[p] || []).push(r); });
    Object.keys(g).forEach(function (p) { g[p].sort(function (a, b) { return num(a['ID']) - num(b['ID']); }); });
    return g;
  };
  var links = childrenOf('cardLinks', 'Card ID'), notes = childrenOf('cardNotes', 'Card ID'), shots = childrenOf('visitShots', 'Visit ID');

  rows('cards').forEach(function (r) {
    var id = r['ID'], si = ctx.lists.stage.indexOf(r['Stage']), mi = ctx.lists.mix.indexOf(r['Mix Category']), th = r['Content Theme'];
    if (r['Stage'] !== '' && si < 0) warnings.push('Card ' + id + ': stage "' + r['Stage'] + '" is not in Lists; set to Ideas');
    if (r['Mix Category'] !== '' && mi < 0) warnings.push('Card ' + id + ': mix category "' + r['Mix Category'] + '" is not in Lists; left empty');
    if (th !== '' && !(th in themeIdByName)) warnings.push('Card ' + id + ': content theme "' + th + '" is not in Themes; left empty');
    board.cards.push({
      id: id, title: r['Title'], camp: r['Campaign'], status: si >= 0 ? ctx.lists.stagekey[si] : 'idea', owner: r['Owner'] || 'Unassigned',
      post: r['Post Date'], time: r['Post Time'], formats: tb_split_(r['Formats']), plats: tb_split_(r['Platforms']), goal: r['Goal'],
      pers: tb_split_(r['Audience']), cta: r['CTA'], questions: r['Questions'], vo: r['Voiceover'], need: r['Needs'], visit: r['Visit'],
      links: (links[String(id)] || []).map(function (l) { return { k: l['Kind'], t: l['Title'], u: l['URL'] }; }),
      notes: (notes[String(id)] || []).map(function (n) { return [n['Author'], n['Note']]; }),
      caption: r['Caption'], capEs: r['Spanish Caption'], tags: r['Hashtags'], mix: mi >= 0 ? ctx.lists.mixcode[mi] : '',
      theme: th in themeIdByName ? themeIdByName[th] : '', pillar: r['Pillar']
    });
  });
  rows('topics').forEach(function (r) { board.topics.push({ id: r['ID'], m: r['Month'], date: r['Date'], label: r['Label'], kind: r['Kind'] }); });
  rows('camps').forEach(function (r) { board.camps.push({ id: r['ID'], n: r['Campaign'], c: r['Colour'], cta: r['CTA'], tags: r['Hashtags'] }); });
  rows('themes').forEach(function (r) {
    board.themes.push({ id: r['ID'], n: r['Theme'], cov: r['What it covers'], pil: tb_split_(r['Home pillars']), freq: r['Minimum frequency'],
      fn: r['Count'] === '' ? 1 : r['Count'], fp: r['Per'] || 'month', off: r['In use'] === 'No' });
  });
  rows('docs').forEach(function (r) { board.docs.push({ id: r['ID'], l: r['Level'], ln: r['Level label'], n: r['Document'], a: r['Answers'], s: r['Status'], u: r['Link'] }); });
  rows('classes').forEach(function (r) {
    board.classes.push({ id: r['ID'], prog: r['Program'], name: r['Class'], site: r['Site'], day: r['Day'], time: r['Time'], aud: r['Audience'],
      end: r['End date'], endTxt: r['End note'], enr: r['Enrolled'] === '' ? 0 : r['Enrolled'], att: r['Attended'] === '' ? 0 : r['Attended'], n: r['n'] === '' ? 0 : r['n'] });
  });
  rows('visits').forEach(function (r) {
    var id = r['ID'];
    board.visits.push({ id: id, date: r['Date'], site: r['Site'], who: r['Who'], cls: tb_split_(r['Class IDs']).map(Number).filter(isFinite),
      shots: (shots[String(id)] || []).map(function (s) { return { t: s['Shot'], k: s['Class ID'] === '' ? null : s['Class ID'], d: s['Done'] === 'Yes' }; }) });
  });
  rows('months').forEach(function (r) {
    var m = r['Month'], p = function (v) { return v === '' ? 0 : v; };
    board.mix[m] = { e: p(r['Educational %']), c: p(r['Community %']), p: p(r['Program/Enrollment %']), o: p(r['Organizational %']), lock: tb_split_(r['Locked']), camps: r['Campaigns (mix text)'], why: r['Why this mix'] };
    board.meta[m] = { theme: r['Theme'], camps: tb_split_(r['Campaign list']), mtcamps: r['Campaigns (topics text)'] };
  });
  rows('pillars').forEach(function (r) { board.pillars.push(r['Pillar']); if (r['Type'] !== '') board.pillarType[r['Pillar']] = r['Type']; });
  rows('personas').forEach(function (r) { board.personas.push([r['Persona'], r['Role']]); });
  rows('people').forEach(function (r) { board.people.push(r['Person']); });
  rows('settings').forEach(function (r) {
    var k = r['Key'];
    if (TB_LINK_SETTINGS.indexOf(k) >= 0) board.links[k] = r['Value']; else board.texts[k] = r['Value'];
  });
  return { board: board, warnings: warnings };
}
