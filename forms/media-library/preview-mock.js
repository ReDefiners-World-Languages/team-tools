// Preview mode only (no apiUrl, or ?preview=1). Pretends to be the Apps Script API so the page
// can be reviewed without touching Google Drive. Nothing leaves the browser.
// The lists come from apps-script/Defaults.gs, so the preview shows the real names. Folder checks
// follow Code.gs (typed names, new campaigns, folders that already exist) on a small fake Drive.
// Test names: a file whose name contains "drop" loses its connection once at about half way.
(function () {
  let config = null;
  const uploads = {}; // url -> { size, received, dropped, meta }
  const library = [];  // files "uploaded" in this preview, plus a few samples
  const folders = new Set(); // fake Drive: every folder path, "Campaigns/MCP Enrollment/Student Referral"
  const OTHER = '__other__', NONE = '__none__';
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

  async function loadDefaults() {
    if (config) return config;
    const text = await (await fetch('apps-script/Defaults.gs', { cache: 'no-store' })).text();
    const DEFAULTS = new Function(text + '\nreturn DEFAULTS;')();
    config = { staffDomain: 'redefinerswl.org', maxFileGb: 10, collections: DEFAULTS.collections.filter(c => c.active).map(c => JSON.parse(JSON.stringify(c))) };
    seedDrive();
    for (const c of config.collections) {
      c.optionalFields = c.optionalFields || [];
      c.dateLabel = c.dateLabel || '';
      c.known = {};
      for (const st of c.steps) if (st.allowNew && !st.dependsOn) c.known[st.id] = childNames(c.label);
    }
    seedSamples();
    return config;
  }

  function addFolder(path) { const parts = path.split('/'); for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join('/')); }
  function childNames(path) { return [...folders].filter(f => f.startsWith(path + '/') && !f.slice(path.length + 1).includes('/')).map(f => f.slice(path.length + 1)).sort(); }

  /** A sample Drive like the real one: campaign folders (incl. the two left out of the picker), a few event folders. */
  function seedDrive() {
    for (const c of config.collections) addFolder(c.label);
    for (const n of ['Coke Florida Partnership', 'Property Tax Education', 'Fundraising', 'MCP Enrollment', 'MyReDefiners Portal', 'Global Explorers', 'Summer STEAM', 'Contracted Services']) addFolder('Campaigns/' + n);
    const camp = config.collections.find(c => c.id === 'campaigns');
    if (camp) for (const [parent, subs] of Object.entries(camp.options.subcampaign || {})) for (const s of subs) addFolder(`Campaigns/${parent}/${s}`);
    addFolder(`Events/Outreach/${today} - Fall Festival at BGC Dover`);
    addFolder(`Events/Outreach/${today} - Library Story Time`);
    addFolder(`People/Moment/${today} - Team game day`);
  }

  function placeholder(label, hue) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="hsl(${hue},45%,82%)"/>` +
      `<text x="200" y="160" font-family="Montserrat, sans-serif" font-size="22" font-weight="700" text-anchor="middle" fill="#00303F">${label}</text></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function seedSamples() {
    const samples = [
      ['classes', 'IMG_4471.jpg', 'photo', { program: 'MCP', course: "Let's Learn Arabic", site: 'CBFRC Temple Terrace' }, 'Arabic class, cooking day', '2026-10-14'],
      ['classes', 'VID_0193.mp4', 'video', { program: 'MCP', course: 'ESOL', subcourse: 'English for Daily Life', site: 'BGC Plant City' }, 'Grocery role play', '2026-10-14'],
      ['classes', '20261014_101522.jpg', 'photo', { program: 'GEP', course: 'Spanish', site: 'Lomax Elementary' }, 'Day of the Dead crafts', '2026-10-14'],
      ['classes', '1729000123.jpg', 'photo', { program: 'MCP', course: 'English for School Success', subcourse: OTHER, site: OTHER }, 'Reading circle', '2026-10-14'],
      ['events', 'IMG_5120.jpg', 'photo', { kind: 'Outreach', name: 'Fall Festival at BGC Dover' }, 'Families at our booth', today],
      ['events', 'IMG_5121.jpg', 'photo', { kind: 'Outreach', name: 'Library Story Time' }, 'Bilingual story corner', today],
      ['people', 'IMG_5300.jpg', 'photo', { kind: 'Moment', name: 'Team game day' }, 'Team trivia', today],
      ['campaigns', 'IMG_4980.jpg', 'photo', { campaign: 'MCP Enrollment', subcampaign: 'Student Referral' }, 'Referral flyer shoot', '2026-10-30'],
      ['campaigns', 'VID_0201.mp4', 'video', { campaign: 'Summer STEAM' }, 'Robotics demo', '2026-07-18']
    ];
    samples.forEach(([colId, name, kind, chosen, what, date], i) => {
      const col = config.collections.find(c => c.id === colId);
      if (!col) return;
      const dest = resolve(col, chosen, { what, date }, {}, true);
      addFolder([col.label, ...dest.segments].join('/'));
      library.push(makeFile(col, dest, name, kind, { what, date }, placeholder(kind === 'video' ? 'Sample video' : 'Sample photo', 20 + i * 40)));
    });
  }

  const wait = ms => new Promise(r => setTimeout(r, ms));
  const err = (code, message) => Object.assign(new Error(message), { code, retryable: false });
  const norm = s => String(s || '').replace(/[‘’ʼ`]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  const looseFind = (list, v) => list.find(x => norm(x) === norm(v)) || '';

  function cleanName(raw, st, label) {
    const v = String(raw || '').replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
    const max = st.maxLength || 60;
    if (!v) throw err('bad_choice', 'Type the ' + label.charAt(0).toLowerCase() + label.slice(1) + '.');
    if (v.length > max) throw err('bad_choice', `${label} is longer than ${max} characters.`);
    if (/[\/\\<>:"|?*]/.test(v)) throw err('bad_choice', `${label} cannot contain / \\ < > : " | ? or *.`);
    if (v.startsWith('.')) throw err('bad_choice', `${label} cannot start with a dot.`);
    return v;
  }

  /** Mirrors resolveDestination_ + ensureFolders_ in Code.gs (dry = samples, nothing refused for extra values). */
  function resolve(col, choices, ctx, confirmNew, dry) {
    const chosen = {}, vals = {}, created = [];
    for (const st of col.steps) {
      let list;
      if (!st.dependsOn) list = (col.options[st.id] || {})[''] || [];
      else { const p = chosen[st.dependsOn]; list = p && p !== OTHER && p !== NONE ? ((col.options[st.id] || {})[p] || []) : []; }
      const value = String(choices[st.id] || '').trim();
      if (!list.length) { if (value && !dry) throw err('bad_choice', st.label + ' does not apply to this choice.'); continue; }
      if (st.input === 'text') { chosen[st.id] = vals[st.id] = cleanName(value, st, list[0]); continue; }
      if (!value) throw err('bad_choice', 'Pick a ' + st.label.toLowerCase() + '.');
      if (value === OTHER) { chosen[st.id] = OTHER; vals[st.id] = st.otherFolder; continue; }
      if (value === NONE) { chosen[st.id] = NONE; continue; }
      let hit = list.includes(value) ? value : (st.allowNew ? looseFind(list, value) : '');
      if (!hit && st.allowNew && !st.dependsOn) hit = looseFind(childNames(col.label), value);
      if (hit) { chosen[st.id] = vals[st.id] = hit; continue; }
      if (!st.allowNew) throw err('bad_choice', 'Pick a ' + st.label.toLowerCase() + ' from the list.');
      const fresh = cleanName(value, st, st.label);
      if (norm(confirmNew[st.id]) !== norm(fresh)) throw err('confirm_new', `Confirm that you want a new ${st.label.toLowerCase()} folder named "${fresh}".`);
      chosen[st.id] = vals[st.id] = fresh;
      created.push(st);
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ctx.date || '');
    if (col.contextFields.includes('date') && (!m || ctx.date < '2016-01-01' || ctx.date > today)) throw err('bad_context', 'Pick the ' + (col.dateLabel || 'date of the class').replace(/^Date/, 'date') + '.');
    const d = m ? { year: m[1], mm: m[2], iso: ctx.date } : { year: today.slice(0, 4), mm: today.slice(5, 7), iso: today };
    Object.assign(vals, { year: d.year, month: `${d.mm} ${MONTHS[Number(d.mm) - 1]} ${d.year}`, date: d.iso });
    // Folders, finding typed names in Drive ignoring capitals and spacing (as ensureFolders_ does).
    const segments = [];
    let here = col.label;
    for (const part of col.path.split('/')) {
      const keys = [...part.matchAll(/\{(\w+)\}/g)].map(x => x[1]);
      if (keys.length && !keys.every(k => vals[k])) { if (keys.some(k => vals[k])) throw err('bad_choice', 'Something is missing for the folder ' + part + '.'); continue; }
      let name = part.replace(/\{(\w+)\}/g, (x, k) => vals[k]).trim();
      const typed = keys.some(k => { const st = col.steps.find(s => s.id === k); return st && (st.input === 'text' || created.includes(st)); });
      if (typed) {
        const found = looseFind(childNames(here), name);
        if (found && found !== name) {
          name = found;
          const re = new RegExp('^' + part.split(/(\{\w+\})/).map(b => /^\{\w+\}$/.test(b) ? '(.+?)' : b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$');
          const got = re.exec(found);
          keys.forEach((k, i) => { if (got && chosen[k] && chosen[k] !== OTHER) chosen[k] = got[i + 1]; });
        }
      }
      segments.push(name);
      here += '/' + name;
    }
    const existing = childNames(col.label);
    return { chosen, segments, created: created.filter(st => !existing.includes(chosen[st.id])), d };
  }

  function makeFile(col, dest, name, kind, ctx, thumb) {
    const path = [col.label, ...dest.segments].join('/');
    const lines = [];
    if (ctx.what) lines.push('What happened: ' + ctx.what);
    if (ctx.date) lines.push((col.dateLabel || 'Class or event date') + ': ' + ctx.date);
    if (ctx.staff) lines.push('Instructor or staff: ' + ctx.staff);
    if (ctx.notes) lines.push('Notes: ' + ctx.notes);
    if (ctx.otherNote) lines.push('Placement note: ' + ctx.otherNote);
    lines.push('Folder: ' + path);
    const props = { year: dest.d.year, month: dest.d.mm, type: kind };
    for (const [k, v] of Object.entries(dest.chosen)) if (v !== NONE) props[k] = v === OTHER ? 'Other' : v;
    return {
      id: 'mock' + Math.random().toString(36).slice(2), col: col.id, name, kind, path, size: 0, link: '',
      hasThumbnail: !!thumb, thumb, description: lines.join('\n'), props
    };
  }

  window.MockApi = async function (action, body) {
    await wait(250);
    const cfg = await loadDefaults();
    const col = cfg.collections.find(c => c.id === (body.collection || cfg.collections[0].id));
    if (action === 'config') return cfg;
    if (action === 'whoami') return { email: 'you@redefinerswl.org', name: 'Preview User' };
    if (action === 'start') return { who: { email: 'you@redefinerswl.org', name: 'Preview User' }, config: cfg };
    if (action === 'existingFolders') {
      const st = col.steps.find(s => s.id === body.step && s.input === 'text');
      if (!st) throw err('bad_request', 'That field has no folders to list.');
      const dest = resolve(col, { ...body.choices, [st.id]: 'x' }, { date: body.date }, {}, true);
      const at = dest.segments.findIndex(s => s.endsWith(' - x'));
      const parent = [col.label, ...dest.segments.slice(0, at)].join('/');
      const prefix = body.date + ' - ';
      return { names: childNames(parent).filter(n => n.startsWith(prefix)).map(n => n.slice(prefix.length)) };
    }
    if (action === 'startUpload') {
      if (col.contextFields.includes('what') && !col.optionalFields.includes('what') && !(body.context || {}).what) throw err('bad_context', 'Say what happened (class, event or activity).');
      const dest = resolve(col, body.choices || {}, body.context || {}, body.confirmNew || {});
      const path = [col.label, ...dest.segments].join('/');
      for (const st of dest.created) { // a new campaign joins the list, as the admin sheet row does
        const list = col.options[st.id][''];
        if (!list.some(x => norm(x) === norm(dest.chosen[st.id]))) list.push(dest.chosen[st.id]);
      }
      addFolder(path);
      for (const c of cfg.collections) for (const id of Object.keys(c.known || {})) c.known[id] = childNames(c.label);
      const taken = library.filter(f => f.path === path).map(f => f.name);
      let savedAs = body.file.name;
      const dot = savedAs.lastIndexOf('.');
      for (let n = 2; taken.includes(savedAs); n++) savedAs = dot > 0 ? `${body.file.name.slice(0, dot)} (${n})${body.file.name.slice(dot)}` : `${body.file.name} (${n})`;
      const url = 'mock:' + Math.random().toString(36).slice(2);
      const kind = /^video\//.test(body.file.type) ? 'video' : 'photo';
      uploads[url] = { size: body.file.size, received: 0, dropped: false, meta: { name: body.file.name } };
      library.push({ ...makeFile(col, dest, savedAs, kind, body.context || {}, ''), pending: url });
      return { uploadUrl: url, token: 't', savedAs, path };
    }
    if (action === 'finishUpload') return { logged: true };
    const visible = library.filter(f => !f.pending && f.col === col.id);
    if (action === 'search') {
      const words = (body.q || '').toLowerCase().split(/\s+/).filter(Boolean);
      const hits = visible.filter(f => words.every(w => (f.name + ' ' + f.description).toLowerCase().includes(w)) &&
        Object.entries(body.filters || {}).every(([k, v]) => !v || f.props[k] === v));
      return { files: hits.map(out), nextPageToken: '' };
    }
    if (action === 'browse') {
      const prefix = body.folderId || col.label;
      const here = prefix.split('/');
      return {
        crumbs: here.map((name, i) => ({ id: here.slice(0, i + 1).join('/'), name })),
        folders: childNames(prefix).map(name => ({ id: prefix + '/' + name, name })),
        files: visible.filter(f => f.path === prefix).map(out), nextPageToken: ''
      };
    }
    if (action === 'thumbnails') {
      const dataUrls = {};
      for (const id of body.fileIds || []) { const f = library.find(x => x.id === id); if (f && f.thumb) dataUrls[id] = f.thumb; }
      return { dataUrls };
    }
    if (action === 'thumbnail') {
      const f = library.find(x => x.id === body.fileId);
      return { dataUrl: f ? f.thumb : '' };
    }
    throw err('bad_request', 'Unknown action.');
  };

  function out(f) {
    return { id: f.id, name: f.name, path: f.path, size: f.size, kind: f.kind, hasThumbnail: f.hasThumbnail, description: f.description, link: f.link };
  }

  // Stands in for the PUT to Google's resumable upload URL.
  window.MockUpload = async function (url, blob, rangeHeader, onProgress) {
    const u = uploads[url];
    if (!u) return { status: 404, range: null, text: '' };
    if (!blob) { // status query
      return u.received >= u.size ? { status: 200, range: null, text: JSON.stringify({ id: finish(url) }) }
        : { status: 308, range: u.received ? `bytes=0-${u.received - 1}` : null, text: '' };
    }
    const start = Number(/bytes (\d+)-/.exec(rangeHeader)[1]);
    if (start !== u.received) return { status: 400, range: null, text: '' };
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      await wait(Math.min(400, 40 + blob.size / 2e6));
      if (/drop/i.test(u.meta.name) && !u.dropped && (start + blob.size * i / steps) >= u.size / 2) {
        u.dropped = true;
        u.received = start; // the half-sent chunk is lost, like a real dropped connection
        throw Object.assign(new Error('Connection lost.'), { code: 'network', retryable: true });
      }
      onProgress && onProgress(blob.size * i / steps);
    }
    u.received = start + blob.size;
    if (u.received >= u.size) return { status: 200, range: null, text: JSON.stringify({ id: finish(url) }) };
    return { status: 308, range: `bytes=0-${u.received - 1}`, text: '' };
  };

  function finish(url) {
    const f = library.find(x => x.pending === url);
    if (f) { delete f.pending; f.hasThumbnail = true; f.thumb = placeholder(f.kind === 'video' ? 'Your video' : 'Your photo', 170); }
    return f ? f.id : 'x';
  }
})();
