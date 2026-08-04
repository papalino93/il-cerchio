const { list, put, del } = require('@vercel/blob');

const CODE_RE = /^[a-z0-9]{4,24}$/i;
const MAX_TASKS = 200;
const KEEP_VERSIONS = 2;

function prefix(code) {
  return `rooms/${code.toLowerCase()}/`;
}

function emptyRoom() {
  return { _v: '', setup: { name: '', place: '', size: 0, lang: 'it' }, tasks: [] };
}

/* Vercel Blob serve i contenuti tramite CDN: sovrascrivere lo stesso
   pathname può restituire per un po' la versione precedente anche con
   query string diverse. Scriviamo invece una versione nuova a ogni
   salvataggio (pathname mai visto prima, quindi mai in cache), leggiamo
   la più recente tramite list() (piano di controllo, non CDN) e mettiamo
   il nome-versione nella risposta: il client scarta ogni risposta con una
   versione più vecchia di quella che ha già in mano, qualunque sia
   l'ordine con cui le richieste di rete arrivano indietro. */
function stampNow() {
  return Date.now().toString().padStart(14, '0') + '-' + Math.random().toString(36).slice(2, 8);
}

async function readRoom(code) {
  try {
    const { blobs } = await list({ prefix: prefix(code), limit: 1000 });
    if (!blobs.length) return emptyRoom();
    blobs.sort((a, b) => (a.pathname < b.pathname ? 1 : -1));
    const latest = blobs[0];
    const res = await fetch(latest.url, { cache: 'no-store' });
    if (!res.ok) return emptyRoom();
    const data = await res.json();
    if (!data || typeof data !== 'object') return emptyRoom();
    data.setup = data.setup || emptyRoom().setup;
    data.tasks = Array.isArray(data.tasks) ? data.tasks : [];
    data._v = latest.pathname.slice(prefix(code).length).replace(/\.json$/, '');
    return data;
  } catch {
    return emptyRoom();
  }
}

async function writeRoom(code, room) {
  const stamp = stampNow();
  const pathname = `${prefix(code)}${stamp}.json`;
  room._v = stamp;
  await put(pathname, JSON.stringify(room), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
  });
  // pulizia delle versioni vecchie, senza bloccare la risposta
  list({ prefix: prefix(code), limit: 1000 })
    .then(({ blobs }) => {
      blobs.sort((a, b) => (a.pathname < b.pathname ? 1 : -1));
      const stale = blobs.slice(KEEP_VERSIONS);
      if (stale.length) return del(stale.map(b => b.url));
    })
    .catch(() => {});
}

function rid() {
  return 't_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const code = String(req.query.code || '').trim();
  if (!CODE_RE.test(code)) {
    res.status(400).json({ error: 'invalid_code' });
    return;
  }

  if (req.method === 'GET') {
    const room = await readRoom(code);
    res.status(200).json(room);
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
  const action = body.action;

  const room = await readRoom(code);

  if (action === 'saveSetup') {
    const s = body.setup || {};
    room.setup = {
      name: String(s.name || '').slice(0, 60),
      place: String(s.place || '').slice(0, 80),
      size: Math.max(0, Math.min(30, parseInt(s.size, 10) || 0)),
      lang: s.lang === 'en' ? 'en' : 'it',
    };
  } else if (action === 'addTask') {
    if (room.tasks.length >= MAX_TASKS) room.tasks.shift();
    const t = body.task || {};
    room.tasks.push({
      id: rid(),
      taskType: String(t.taskType || 'altro').slice(0, 30),
      when: String(t.when || '').slice(0, 20),
      day: String(t.day || '').slice(0, 20),
      detail: String(t.detail || '').slice(0, 200),
      note: String(t.note || '').slice(0, 300),
      list: Array.isArray(t.list) ? t.list.slice(0, 30).map(x => String(x).slice(0, 80)) : [],
      lang: t.lang === 'en' ? 'en' : 'it',
      status: 'open',
      claimedBy: '',
      createdAt: Date.now(),
    });
  } else if (action === 'claim' || action === 'unclaim' || action === 'done' || action === 'reopen') {
    const idx = room.tasks.findIndex(x => x.id === body.id);
    if (idx !== -1) {
      if (action === 'claim') { room.tasks[idx].status = 'claimed'; room.tasks[idx].claimedBy = String(body.by || '').slice(0, 40); }
      if (action === 'unclaim') { room.tasks[idx].status = 'open'; room.tasks[idx].claimedBy = ''; }
      if (action === 'done') { room.tasks[idx].status = 'done'; room.tasks[idx].doneAt = Date.now(); }
      if (action === 'reopen') { room.tasks[idx].status = 'open'; room.tasks[idx].claimedBy = ''; }
    }
  } else if (action === 'remove') {
    room.tasks = room.tasks.filter(x => x.id !== body.id);
  } else if (action === 'clearDone') {
    room.tasks = room.tasks.filter(x => x.status !== 'done');
  } else {
    res.status(400).json({ error: 'unknown_action' });
    return;
  }

  await writeRoom(code, room);
  res.status(200).json(room);
};
