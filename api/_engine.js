/* Motore condiviso tra Il Cerchio e I Compiti: questo file è identico nei
   due progetti. api/room.js lo importa passando solo i due titoli delle
   notifiche push. Se lo modifichi, copialo nell'altro repo invece di
   ripetere la modifica a mano. */

const { list, put, del } = require('@vercel/blob');
const webpush = require('web-push');

const CODE_RE = /^[a-z0-9]{4,24}$/i;
const MAX_TASKS = 200;
const MAX_MEMBERS = 60;
const KEEP_VERSIONS = 2;

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:example@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

function prefix(code) {
  return `rooms/${code.toLowerCase()}/`;
}

function emptyRoom() {
  return { _v: '', setup: { name: '', place: '', size: 0, lang: 'it' }, tasks: [], members: [], pending: [], pushSubs: {} };
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
    data.members = Array.isArray(data.members) ? data.members : [];
    data.pending = Array.isArray(data.pending) ? data.pending : [];
    data.pushSubs = data.pushSubs && typeof data.pushSubs === 'object' ? data.pushSubs : {};
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

function isMember(room, id) {
  return !!id && room.members.some(m => m.id === id);
}

// Manda una notifica push a tutti i membri tranne chi ha fatto l'azione.
// Best-effort: un abbonamento scaduto (404/410) viene rimosso, il resto
// degli errori viene ignorato senza far fallire la richiesta principale.
async function notifyOthers(room, excludeId, body, NOTIFY) {
  if (!process.env.VAPID_PRIVATE_KEY) return;
  const lang = (room.setup && room.setup.lang === 'en') ? 'en' : 'it';
  const strings = NOTIFY[lang];
  const payload = JSON.stringify({ title: strings.title, body });
  const entries = Object.entries(room.pushSubs || {}).filter(([id]) => id !== excludeId);
  let changed = false;
  await Promise.allSettled(entries.map(([id, sub]) =>
    webpush.sendNotification(sub, payload).catch(err => {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        delete room.pushSubs[id];
        changed = true;
      }
    })
  ));
  return changed;
}

// Azioni che richiedono di essere già dentro lo spazio (cerchio/gruppo).
const MEMBER_ONLY = new Set([
  'saveSetup', 'addTask', 'editTask', 'claim', 'unclaim', 'done', 'reopen', 'remove', 'clearDone',
  'approve', 'deny', 'savePush', 'removePush', 'removeMember',
]);

const RECURRING = new Set(['ognigiorno', 'ricorrente']);

// title: il nome dell'app (usato come titolo delle notifiche push, uguale
// nelle due lingue). Vedi api/room.js per il valore di ciascun progetto.
function createHandler(title) {
  const NOTIFY = {
    it: { title, joinReq: name => `${name} chiede di entrare.`, newTask: name => `${name} ha aggiunto un compito.` },
    en: { title, joinReq: name => `${name} is asking to join.`, newTask: name => `${name} added a task.` },
  };

  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    const code = String(req.query.code || '').trim();
    if (!CODE_RE.test(code)) {
      res.status(400).json({ error: 'invalid_code' });
      return;
    }

    if (req.method === 'GET') {
      const room = await readRoom(code);
      delete room.pushSubs; // non serve al client, e sono dati di consegna, non di stanza
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

    // Lo spazio è chiuso: per fare qualsiasi cosa oltre a chiedere di
    // entrare, bisogna già essere tra i membri. Verifica server-side, non
    // solo nell'interfaccia: un memberId non valido o non ancora
    // approvato viene respinto qui.
    if (MEMBER_ONLY.has(action) && !isMember(room, body.memberId)) {
      res.status(403).json({ error: 'not_a_member' });
      return;
    }

    let notify = null;

    if (action === 'join') {
      const id = String(body.id || '').slice(0, 40);
      const name = String(body.name || '').slice(0, 60);
      if (!id || !name) { res.status(400).json({ error: 'missing_fields' }); return; }
      if (room.members.some(m => m.id === id)) {
        // già dentro: aggiorna solo il nome, se cambiato
        room.members = room.members.map(m => m.id === id ? { ...m, name } : m);
      } else if (room.pending.some(p => p.id === id)) {
        room.pending = room.pending.map(p => p.id === id ? { ...p, name } : p);
      } else if (room.members.length === 0) {
        // primo arrivo: lo spazio è vuoto, chi lo crea entra subito
        room.members.push({ id, name, joinedAt: Date.now() });
      } else {
        if (room.pending.length >= MAX_MEMBERS) room.pending.shift();
        room.pending.push({ id, name, requestedAt: Date.now() });
        notify = strings => strings.joinReq(name);
      }
    } else if (action === 'cancelJoin') {
      // Chi è in attesa non è ancora membro: può ritirare solo la propria
      // richiesta (non serve essere dentro per farlo).
      const id = String(body.id || '');
      if (id) room.pending = room.pending.filter(p => p.id !== id);
    } else if (action === 'approve') {
      const idx = room.pending.findIndex(p => p.id === body.id);
      if (idx !== -1) {
        const [p] = room.pending.splice(idx, 1);
        if (!room.members.some(m => m.id === p.id)) {
          if (room.members.length >= MAX_MEMBERS) { res.status(400).json({ error: 'circle_full' }); return; }
          room.members.push({ id: p.id, name: p.name, joinedAt: Date.now() });
        }
      }
    } else if (action === 'deny') {
      room.pending = room.pending.filter(p => p.id !== body.id);
    } else if (action === 'leave') {
      room.members = room.members.filter(m => m.id !== body.memberId);
      delete room.pushSubs[body.memberId];
    } else if (action === 'removeMember') {
      // Chiunque sia dentro può togliere chiunque altro (stessa logica
      // simmetrica dell'approvazione), ma non se stesso: per quello c'è "leave".
      const id = String(body.id || '');
      if (id && id !== body.memberId) {
        room.members = room.members.filter(m => m.id !== id);
        delete room.pushSubs[id];
      }
    } else if (action === 'savePush') {
      const sub = body.sub;
      if (!sub || !sub.endpoint) { res.status(400).json({ error: 'missing_fields' }); return; }
      room.pushSubs[body.memberId] = sub;
    } else if (action === 'removePush') {
      delete room.pushSubs[body.memberId];
    } else if (action === 'saveSetup') {
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
      const actor = room.members.find(m => m.id === body.memberId);
      notify = strings => strings.newTask(actor ? actor.name : '?');
    } else if (action === 'editTask') {
      const idx = room.tasks.findIndex(x => x.id === body.id);
      if (idx !== -1) {
        const t = body.task || {};
        const cur = room.tasks[idx];
        room.tasks[idx] = {
          ...cur,
          taskType: String(t.taskType || cur.taskType).slice(0, 30),
          when: String(t.when || '').slice(0, 20),
          day: String(t.day || '').slice(0, 20),
          detail: String(t.detail || '').slice(0, 200),
          note: String(t.note || '').slice(0, 300),
          list: Array.isArray(t.list) ? t.list.slice(0, 30).map(x => String(x).slice(0, 80)) : [],
        };
      }
    } else if (action === 'claim' || action === 'unclaim' || action === 'done' || action === 'reopen') {
      const idx = room.tasks.findIndex(x => x.id === body.id);
      if (idx !== -1) {
        if (action === 'claim') { room.tasks[idx].status = 'claimed'; room.tasks[idx].claimedBy = String(body.by || '').slice(0, 40); }
        if (action === 'unclaim') { room.tasks[idx].status = 'open'; room.tasks[idx].claimedBy = ''; }
        if (action === 'done') {
          room.tasks[idx].status = 'done';
          room.tasks[idx].doneAt = Date.now();
          // "Ogni giorno"/"Ogni settimana" non sono solo un'etichetta: quando
          // lo spunti, il compito torna da capo per la prossima volta.
          const src = room.tasks[idx];
          if (RECURRING.has(src.when) && room.tasks.length < MAX_TASKS) {
            room.tasks.push({
              id: rid(), taskType: src.taskType, when: src.when, day: '',
              detail: src.detail, note: src.note, list: src.list, lang: src.lang,
              status: 'open', claimedBy: '', createdAt: Date.now(),
            });
          }
        }
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

    if (notify) {
      const lang = (room.setup && room.setup.lang === 'en') ? 'en' : 'it';
      await notifyOthers(room, body.memberId, notify(NOTIFY[lang]), NOTIFY);
    }

    await writeRoom(code, room);
    const out = { ...room };
    delete out.pushSubs;
    res.status(200).json(out);
  };
}

module.exports = { createHandler };
