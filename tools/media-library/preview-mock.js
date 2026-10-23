// Preview mode only (no apiUrl, or ?preview=1). Pretends to be the Apps Script API so the page
// can be reviewed without touching Google Drive. Nothing leaves the browser.
// The lists come from apps-script/Defaults.gs, so the preview shows the real names.
// Test names: a file whose name contains "drop" loses its connection once at about half way.
(function () {
  let config = null;
  const uploads = {}; // url -> { size, received, dropped, meta }
  const library = [];  // files "uploaded" in this preview, plus a few samples

  async function loadDefaults() {
    if (config) return config;
    const text = await (await fetch('apps-script/Defaults.gs', { cache: 'no-store' })).text();
    const DEFAULTS = new Function(text + '\nreturn DEFAULTS;')();
    config = { staffDomain: 'redefinerswl.org', maxFileGb: 10, collections: DEFAULTS.collections.filter(c => c.active) };
    seedSamples(config.collections[0]);
    return config;
  }

  function placeholder(label, hue) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="hsl(${hue},45%,82%)"/>` +
      `<text x="200" y="160" font-family="Montserrat, sans-serif" font-size="22" font-weight="700" text-anchor="middle" fill="#00303F">${label}</text></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function seedSamples(col) {
    const samples = [
      ['IMG_4471.jpg', 'photo', { program: 'MCP', course: "Let's Learn Arabic", site: 'CBFRC Temple Terrace' }, 'Arabic class, cooking day'],
      ['IMG_4472.jpg', 'photo', { program: 'MCP', course: "Let's Learn Arabic", site: 'CBFRC Temple Terrace' }, 'Arabic class, cooking day'],
      ['VID_0193.mp4', 'video', { program: 'MCP', course: 'ESOL', subcourse: 'English for Daily Life', site: 'BGC Plant City' }, 'Grocery role play'],
      ['20261014_101522.jpg', 'photo', { program: 'GEP', course: 'Spanish', site: 'Lomax Elementary' }, 'Day of the Dead crafts'],
      ['1729000123.jpg', 'photo', { program: 'MCP', course: 'English for School Success', subcourse: 'Other', site: 'Other' }, 'Reading circle']
    ];
    samples.forEach(([name, kind, chosen, what], i) => {
      library.push(makeFile(col, name, kind, chosen, { what, date: '2026-10-14' }, placeholder(kind === 'video' ? 'Sample video' : 'Sample photo', 20 + i * 60)));
    });
  }

  function folderNames(col, chosen) {
    return col.steps.filter(s => chosen[s.id]).map(s => chosen[s.id] === 'Other' ? s.otherFolder : chosen[s.id]);
  }

  function makeFile(col, name, kind, chosen, ctx, thumb) {
    const d = new Date();
    const month = d.toLocaleString('en-US', { month: 'long' });
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const path = [col.label, ...folderNames(col, chosen), String(d.getFullYear()), `${mm} ${month} ${d.getFullYear()}`].join('/');
    const lines = [];
    if (ctx.what) lines.push('What happened: ' + ctx.what);
    if (ctx.date) lines.push('Class or event date: ' + ctx.date);
    if (ctx.staff) lines.push('Instructor or staff: ' + ctx.staff);
    if (ctx.notes) lines.push('Notes: ' + ctx.notes);
    if (ctx.otherNote) lines.push('Placement note: ' + ctx.otherNote);
    lines.push('Folder: ' + path);
    return {
      id: 'mock' + Math.random().toString(36).slice(2), name, kind, path, size: 0, link: '',
      hasThumbnail: !!thumb, thumb, description: lines.join('\n'),
      props: { ...chosen, year: String(d.getFullYear()), month: mm, type: kind }
    };
  }

  const wait = ms => new Promise(r => setTimeout(r, ms));
  const err = (code, message) => Object.assign(new Error(message), { code, retryable: false });

  window.MockApi = async function (action, body) {
    await wait(250);
    const cfg = await loadDefaults();
    const col = cfg.collections.find(c => c.id === (body.collection || cfg.collections[0].id));
    if (action === 'config') return cfg;
    if (action === 'startUpload') {
      const chosen = {};
      for (const [k, v] of Object.entries(body.choices || {})) chosen[k] = v === '__other__' ? 'Other' : v;
      const path = makeFile(col, '', '', chosen, {}, '').path;
      const taken = library.filter(f => f.path === path).map(f => f.name);
      let savedAs = body.file.name;
      const dot = savedAs.lastIndexOf('.');
      for (let n = 2; taken.includes(savedAs); n++) savedAs = dot > 0 ? `${body.file.name.slice(0, dot)} (${n})${body.file.name.slice(dot)}` : `${body.file.name} (${n})`;
      const url = 'mock:' + Math.random().toString(36).slice(2);
      uploads[url] = { size: body.file.size, received: 0, dropped: false, meta: { savedAs, chosen, ctx: body.context, kind: /^video\//.test(body.file.type) ? 'video' : 'photo', name: body.file.name } };
      library.push({ ...makeFile(col, savedAs, uploads[url].meta.kind, chosen, body.context, ''), pending: url });
      return { uploadUrl: url, token: 't', savedAs, path };
    }
    if (action === 'finishUpload') return { logged: true };
    if (action === 'whoami') return { email: 'you@redefinerswl.org', name: 'Preview User' };
    const visible = library.filter(f => !f.pending);
    if (action === 'search') {
      const words = (body.q || '').toLowerCase().split(/\s+/).filter(Boolean);
      const hits = visible.filter(f => words.every(w => (f.name + ' ' + f.description).toLowerCase().includes(w)) &&
        Object.entries(body.filters || {}).every(([k, v]) => !v || f.props[k] === v));
      return { files: hits.map(out), nextPageToken: '' };
    }
    if (action === 'browse') {
      const here = body.folderId ? body.folderId.split('/') : [col.label];
      const prefix = here.join('/');
      const folders = [...new Set(visible.filter(f => f.path.startsWith(prefix + '/'))
        .map(f => f.path.slice(prefix.length + 1).split('/')[0]))].sort()
        .map(name => ({ id: prefix + '/' + name, name }));
      return {
        crumbs: here.map((name, i) => ({ id: here.slice(0, i + 1).join('/'), name })),
        folders, files: visible.filter(f => f.path === prefix).map(out), nextPageToken: ''
      };
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
