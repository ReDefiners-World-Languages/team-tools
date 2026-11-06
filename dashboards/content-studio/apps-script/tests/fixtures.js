'use strict';
// Generic sample board used by the tests and by the browser mock. Invented names only: no real staff, donors or links.

function sampleBoard() {
  const cards = [
    {
      id: 101, title: 'Class moments reel', camp: 'MCP Enrollment', status: 'scripting', owner: 'Alex Sample', post: '2026-11-12', time: '12:00',
      formats: ['Reel', 'Story'], plats: ['Instagram', 'Facebook'], goal: 'Show a real class.\nSecond line.', pers: ['Parent Persona', 'Learner Persona'],
      cta: 'Register today', questions: 'What surprised you?\nWhat did you learn?', vo: 'On-screen text', need: 'Photos from the visit', visit: 'v1',
      links: [{ k: 'Canva design', t: 'Reel cover', u: 'https://example.org/canva' }, { k: 'Other', t: 'Brief', u: 'https://example.org/brief' }],
      notes: [['Alex Sample', 'Waiting on photos.'], ['Sam Example', 'Approved script.']],
      caption: 'English caption with a line\nbreak and "quotes".', capEs: 'Pie de foto en español: ¡Inscríbete hoy!', tags: '#Example #Sample',
      mix: 'p', theme: 'outcomes', pillar: 'Class Moments'
    },
    {
      id: 102, title: '=SUM(1,1) is only a title', camp: 'Always-On', status: 'idea', owner: 'Unassigned', post: '', time: '',
      formats: ['Static post'], plats: ['LinkedIn'], goal: '', pers: [], cta: '', questions: '', vo: '', need: '', visit: '',
      links: [], notes: [], caption: '2026-11', capEs: '', tags: '', mix: '', theme: '', pillar: ''
    },
    {
      id: 103, title: '2026 plan reminder', camp: 'MCP Enrollment', status: 'scheduled', owner: 'Sam Example', post: '2026-12-03', time: '09:30',
      formats: ['Email'], plats: ['Email'], goal: 'Remind families.', pers: ['Parent Persona'], cta: 'Open the portal', questions: '', vo: '', need: '', visit: '',
      links: [{ k: 'HubSpot email', t: 'Draft', u: 'https://example.org/email' }], notes: [['Sam Example', 'Published on Dec 3.']],
      caption: 'TRUE', capEs: '', tags: '#Example', mix: 'c', theme: 'spotlights', pillar: 'Voices of the Community'
    }
  ];
  return {
    camps: [
      { id: 'camp1', n: 'MCP Enrollment', c: '#FFC100', cta: 'Register', tags: '#Example' },
      { id: 'camp2', n: 'Always-On', c: '', cta: '', tags: '' }
    ],
    people: ['Unassigned', 'Alex Sample', 'Sam Example'],
    pillars: ['Class Moments', 'Voices of the Community', 'The Complete Guide to Learning Spanish'],
    pillarType: { 'Class Moments': 'social', 'Voices of the Community': 'social', 'The Complete Guide to Learning Spanish': 'blog' },
    personas: [['Parent Persona', 'Parent and caregiver'], ['Learner Persona', 'Adult learner']],
    themes: [
      { id: 'outcomes', n: 'Program outcomes', cov: 'What students achieve.', pil: ['Class Moments'], freq: '1x/month', fn: 1, fp: 'month', off: false },
      { id: 'spotlights', n: 'Community spotlights', cov: 'Stories of real people.', pil: ['Voices of the Community', 'Class Moments'], freq: '1x/week', fn: 1, fp: 'week', off: true }
    ],
    topics: [
      { id: 1, m: '2026-11', date: '2026-11-11', label: 'Veterans Day', kind: 'Civic' },
      { id: 2, m: '2026-12', date: '', label: 'Winter break', kind: '' }
    ],
    mix: {
      '2026-11': { e: 15, c: 15, p: 45, o: 25, lock: ['e', 'p'], camps: 'MCP Enrollment; Always-On', why: 'Enrollment is open.' },
      '2026-12': { e: 0, c: 0, p: 0, o: 0, lock: [], camps: '', why: '' }
    },
    meta: {
      '2026-11': { theme: 'Gratitude', camps: ['MCP Enrollment'], mtcamps: 'MCP Enrollment (open)' },
      '2026-12': { theme: '', camps: [], mtcamps: '' }
    },
    docs: [
      { id: 'doc1', l: '1', ln: '1. Marketing Plan', n: 'Marketing Plan', a: 'Why and where?', s: 'Current/Active', u: 'https://example.org/plan' },
      { id: 'doc2', l: '2', ln: '', n: 'Campaign Brief', a: 'What is the campaign?', s: 'Draft', u: '' }
    ],
    visits: [{ id: 'v1', date: '2026-11-13', site: 'Example Center', who: 'Alex Sample', cls: [1, 2], shots: [{ t: 'Wide shot of the room', k: 1, d: true }, { t: 'Teacher intro', k: null, d: false }] }],
    texts: { banner: 'Welcome to the board', syncNote: '', gepNote: '' },
    links: { mediaLibrary: 'https://example.org/library' },
    cards
  };
}

// Board object -> the ops a page would send to create everything
function opsFor(board) {
  const ops = [];
  ['people', 'pillars', 'pillarType', 'personas', 'texts', 'links'].forEach((k) => ops.push({ c: 'single', id: k, v: board[k] }));
  ['camps', 'themes', 'topics', 'docs', 'visits', 'cards'].forEach((c) => board[c].forEach((v) => ops.push({ c, id: String(v.id), v })));
  Object.keys(board.mix).forEach((m) => ops.push({ c: 'mix', id: m, v: board.mix[m] }));
  Object.keys(board.meta).forEach((m) => ops.push({ c: 'meta', id: m, v: board.meta[m] }));
  return ops;
}

module.exports = { sampleBoard, opsFor };
