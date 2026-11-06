'use strict';
// Local mock back end for browser tests: serves the page and answers /api with the REAL Apps Script code (Code.gs and
// friends) running on the fake workbook. Usage: node mock-server.js [port]. /reset?data=empty|loaded switches the data.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { makeEnv } = require('./harness');
const { sampleBoard, opsFor } = require('./fixtures');

const PAGE = path.join(__dirname, '..', '..', 'index.html');
let env, tok;

function seed(kind) {
  env = makeEnv();
  const claims = { aud: 'test-client.apps.googleusercontent.com', iss: 'https://accounts.google.com', email: 'alex@redefinerswl.org', email_verified: 'true', hd: 'redefinerswl.org', name: 'Alex Sample', exp: String(Math.floor(env.clock.t / 1000) + 99999999) };
  tok = 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s'; // a JWT-shaped test token the page can decode
  env.tokens[tok] = claims;
  if (kind === 'loaded') {
    const b = sampleBoard();
    // more cards across months and stages so every view has something to show
    const stages = ['idea', 'scripting', 'tocapture', 'captured', 'editing', 'review', 'tobesched', 'scheduled'];
    for (let i = 0; i < 24; i++) {
      const c = JSON.parse(JSON.stringify(b.cards[i % 3]));
      c.id = 200 + i; c.title = 'Sample card ' + (i + 1) + (i % 4 === 0 ? ' with a rather long title that has to wrap on a narrow phone screen' : '');
      c.status = stages[i % 8]; c.post = i % 5 === 4 ? '' : '2026-11-' + String(2 + ((i * 3) % 27)).padStart(2, '0'); c.time = i % 2 ? '10:00' : '';
      c.owner = ['Unassigned', 'Alex Sample', 'Sam Example'][i % 3]; c.camp = i % 2 ? 'MCP Enrollment' : 'Always-On'; c.theme = i % 3 === 0 ? 'outcomes' : '';
      b.cards.push(c);
    }
    b.mix['2026-10'] = { e: 20, c: 20, p: 40, o: 20, lock: [], camps: 'MCP Enrollment', why: 'Fall enrollment.' };
    b.meta['2026-10'] = { theme: 'Preparedness', camps: ['MCP Enrollment'], mtcamps: '' };
    b.mix['2026-09'] = { e: 0, c: 0, p: 0, o: 0, lock: [], camps: '', why: '' };
    b.meta['2026-09'] = { theme: '', camps: [], mtcamps: '' };
    const r = env.call('save', { ops: opsFor(b) }, tok);
    if (!r.ok || r.data.rejected.length) throw new Error('seed failed ' + JSON.stringify(r));
    const classes = [
      { id: 1, prog: 'MCP', name: 'ESOL - Basic Living (5.1)', site: 'Example North CBFRC', day: 2, time: '17:30', aud: '', end: '2027-01-28', endTxt: '', enr: 11, att: 78, n: 45 },
      { id: 2, prog: 'MCP', name: 'ESOL - Basic Living (5.1)', site: 'Example North CBFRC', day: 4, time: '17:30', aud: '', end: '2027-01-28', endTxt: '', enr: 11, att: 78, n: 45 },
      { id: 3, prog: 'MCP', name: 'Spanish Workshop for Adults: Beginner (5.1)', site: 'Example Temple CBFRC', day: 4, time: '15:00', aud: 'Adults', end: '2027-12-10', endTxt: '', enr: 4, att: 100, n: 2 },
      { id: 4, prog: 'MCP', name: 'ESOL - Work and Finance (5.1)', site: 'Example Central CBFRC', day: 3, time: '12:30', aud: '', end: '2027-01-27', endTxt: '', enr: 4, att: 60, n: 12 }
    ];
    env.ctx.storeApply_(classes.map((c) => ({ c: 'classes', id: String(c.id), v: c })), 'seed', { allowClasses: true });
  }
  env.run('syncTick()');
}

seed('loaded');
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
  if (url.pathname === '/api') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      const out = env.ctx.doPost({ postData: { contents: body } }).getContent();
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      res.end(out);
    });
    return;
  }
  if (url.pathname === '/reset') { seed(url.searchParams.get('data') === 'empty' ? 'empty' : 'loaded'); res.writeHead(200, cors); return res.end('ok'); }
  if (url.pathname === '/token') { res.writeHead(200, cors); return res.end(tok); }
  if (url.pathname === '/tables') { // peek at the typed tables for the tests
    const out = {};
    ['Cards', 'Months', 'Classes'].forEach((n) => { const sh = env.wb.getSheetByName(n); const l = sh.getLastRow(); out[n] = l < 2 ? [] : sh.getRange(2, 1, l - 1, 12).getDisplayValues(); });
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors)); return res.end(JSON.stringify(out));
  }
  if (url.pathname === '/tick') { env.run('syncTick()'); res.writeHead(200, cors); return res.end('ok'); }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    let html = fs.readFileSync(PAGE, 'utf8');
    const inject = `<script>window.CSB_MOCK_TOKEN=${JSON.stringify(tok)};window.CSB_MOCK_API=async function(action,payload){let r;try{r=await fetch('/api',{method:'POST',body:JSON.stringify(payload)})}catch(e){throw new ApiError('network','No connection to the board storage.')}const j=await r.json();if(!j.ok)throw new ApiError(j.error,j.message);return j.data};</script>`;
    html = html.replace('<body>', '<body>' + inject);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html);
  }
  res.writeHead(404); res.end('not found');
}).listen(Number(process.argv[2] || 8765), () => console.log('mock server on ' + (process.argv[2] || 8765)));
