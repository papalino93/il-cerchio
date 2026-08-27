/* Motore condiviso tra Il Cerchio e I Compiti: questo file è identico nei
   due progetti. api/room.js lo importa passando solo i due titoli delle
   notifiche push. Se lo modifichi, copialo nell'altro repo invece di
   ripetere la modifica a mano. */

const { list, put, del } = require('@vercel/blob');
const webpush = require('web-push');
const crypto = require('crypto');

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
  return {
    _v: '', setup: { name: '', place: '', size: 0, lang: 'it', taskLabels: {} },
    tasks: [], members: [], pending: [], pushSubs: {},
    // owner: id del membro che ha creato lo spazio (il "creatore"). Solo lui
    // può togliere altri membri e impostare/cambiare il PIN di recupero
    // sotto — chi si limita a partecipare (es. un figlio) resta un membro
    // qualunque, senza bisogno di alcuna password.
    owner: '',
    // pinHash: "salt:hash" (scrypt), mai il PIN in chiaro. Serve solo al
    // creatore per rientrare da un telefono/browser che ha perso i dati
    // locali (vedi azione "recoverWithPin"), senza dover essere
    // riapprovato da qualcun altro come un membro nuovo.
    pinHash: '', pinFails: 0, pinLockedUntil: 0,
  };
}

// PIN di recupero del creatore: hashato con scrypt (nativo di Node, niente
// dipendenze in più), mai salvato o restituito in chiaro. Il confronto usa
// timingSafeEqual per non far trapelare via timing quanto del PIN è giusto.
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPin(pin, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  try {
    const check = crypto.scryptSync(pin, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return check.length === expected.length && crypto.timingSafeEqual(check, expected);
  } catch {
    return false;
  }
}

// Toglie dalla risposta i dati che non devono uscire dal server (abbonamenti
// push, hash e contatori del PIN) e aggiunge hasPin/owner, gli unici due
// bit che servono al client per decidere cosa mostrare.
function sanitizeForClient(room) {
  const out = { ...room };
  delete out.pushSubs;
  out.hasPin = !!out.pinHash;
  delete out.pinHash;
  delete out.pinFails;
  delete out.pinLockedUntil;
  return out;
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
    data.setup.taskLabels = (data.setup.taskLabels && typeof data.setup.taskLabels === 'object') ? data.setup.taskLabels : {};
    data.tasks = Array.isArray(data.tasks) ? data.tasks : [];
    data.members = Array.isArray(data.members) ? data.members : [];
    data.pending = Array.isArray(data.pending) ? data.pending : [];
    data.pushSubs = data.pushSubs && typeof data.pushSubs === 'object' ? data.pushSubs : {};
    // Spazi creati prima del "creatore": se non c'è un owner valido, lo
    // spazio non è orfano, semplicemente non l'avevamo ancora registrato.
    // Diventa owner chi è dentro da più tempo — la prossima scrittura lo
    // rende definitivo. Stesso ragionamento se il creatore se n'è andato:
    // il ruolo passa a chi è rimasto da più tempo, invece di sparire.
    if (!data.owner || !data.members.some(m => m.id === data.owner)) {
      const oldest = data.members.slice().sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0))[0];
      data.owner = oldest ? oldest.id : '';
    }
    data.pinHash = typeof data.pinHash === 'string' ? data.pinHash : '';
    data.pinFails = Number.isFinite(data.pinFails) ? data.pinFails : 0;
    data.pinLockedUntil = Number.isFinite(data.pinLockedUntil) ? data.pinLockedUntil : 0;
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

const MAX_ATTACHMENTS = 6;
// Gli URL arrivano da /api/upload (Vercel Blob pubblico): qui verifichiamo
// solo la forma (https, lunghezza ragionevole), non serve altro dato che
// il caricamento è già passato dal controllo di appartenenza.
function sanitizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(u => typeof u === 'string' && /^https:\/\/.{1,290}$/.test(u))
    .slice(0, MAX_ATTACHMENTS);
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
  'approve', 'deny', 'savePush', 'removePush', 'removeMember', 'setPin',
]);
// "recoverWithPin" apposta NON è qui dentro: chi la usa non è (ancora) un
// membro riconosciuto su questo dispositivo — è tutto il punto dell'azione.

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
      res.status(200).json(sanitizeForClient(room));
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
        // primo arrivo: lo spazio è vuoto, chi lo crea entra subito ed è il
        // "creatore" (owner) — vedi emptyRoom() più sopra.
        room.members.push({ id, name, joinedAt: Date.now() });
        room.owner = id;
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
      // Solo il creatore può togliere qualcun altro dal gruppo — è
      // un'azione distruttiva, non va lasciata a chiunque sia dentro.
      if (room.owner && body.memberId !== room.owner) {
        res.status(403).json({ error: 'not_owner' }); return;
      }
      const id = String(body.id || '');
      if (id && id !== body.memberId) {
        room.members = room.members.filter(m => m.id !== id);
        delete room.pushSubs[id];
      }
    } else if (action === 'setPin') {
      // Solo il creatore può impostare/cambiare il proprio PIN di recupero.
      if (room.owner && body.memberId !== room.owner) {
        res.status(403).json({ error: 'not_owner' }); return;
      }
      const pin = String(body.pin || '');
      if (!/^\d{4,8}$/.test(pin)) { res.status(400).json({ error: 'invalid_pin' }); return; }
      room.pinHash = hashPin(pin);
      room.pinFails = 0; room.pinLockedUntil = 0;
    } else if (action === 'recoverWithPin') {
      // Rientro del creatore da un telefono/browser che ha perso i dati
      // locali: codice della stanza (già verificato) + PIN, niente
      // approvazione di nessuno. Blocco temporaneo dopo troppi tentativi
      // sbagliati, per non rendere il PIN forzabile a forza di richieste.
      const now = Date.now();
      if (room.pinLockedUntil && now < room.pinLockedUntil) {
        res.status(429).json({ error: 'pin_locked', retryAt: room.pinLockedUntil }); return;
      }
      if (!room.pinHash) { res.status(400).json({ error: 'no_pin' }); return; }
      const newId = String(body.memberId || '');
      if (!/^m_[a-z0-9]+$/i.test(newId)) { res.status(400).json({ error: 'missing_fields' }); return; }
      if (!verifyPin(String(body.pin || ''), room.pinHash)) {
        room.pinFails = (room.pinFails || 0) + 1;
        if (room.pinFails >= 5) { room.pinLockedUntil = now + 15 * 60 * 1000; room.pinFails = 0; }
        await writeRoom(code, room);
        res.status(403).json({ error: 'wrong_pin' }); return;
      }
      room.pinFails = 0; room.pinLockedUntil = 0;
      const idx = room.members.findIndex(m => m.id === room.owner);
      if (idx !== -1) room.members[idx] = { ...room.members[idx], id: newId };
      else room.members.push({ id: newId, name: String(body.name || '').slice(0, 60) || '?', joinedAt: now });
      room.owner = newId;
    } else if (action === 'savePush') {
      const sub = body.sub;
      if (!sub || !sub.endpoint) { res.status(400).json({ error: 'missing_fields' }); return; }
      room.pushSubs[body.memberId] = sub;
    } else if (action === 'removePush') {
      delete room.pushSubs[body.memberId];
    } else if (action === 'saveSetup') {
      const s = body.setup || {};
      // I pulsanti dei compiti (titolo e dettaglio) si possono rinominare per
      // adattarli alla situazione di ciascuna famiglia (es. "Lavastoviglie" →
      // "Giardino"). Se questa richiesta non tocca le personalizzazioni,
      // quelle già salvate restano intatte invece di sparire.
      let taskLabels = (room.setup && room.setup.taskLabels) || {};
      if (s.taskLabels && typeof s.taskLabels === 'object') {
        taskLabels = {};
        for (const key of Object.keys(s.taskLabels).slice(0, 30)) {
          const id = String(key).slice(0, 30);
          const v = s.taskLabels[key] || {};
          const t = String(v.t || '').slice(0, 40);
          const h = String(v.h || '').slice(0, 60);
          if (t || h) taskLabels[id] = { t, h };
        }
      }
      room.setup = {
        name: String(s.name || '').slice(0, 60),
        place: String(s.place || '').slice(0, 80),
        size: Math.max(0, Math.min(30, parseInt(s.size, 10) || 0)),
        lang: s.lang === 'en' ? 'en' : 'it',
        taskLabels,
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
        attachments: sanitizeAttachments(t.attachments),
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
          attachments: sanitizeAttachments(t.attachments),
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
              attachments: [], status: 'open', claimedBy: '', createdAt: Date.now(),
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
    res.status(200).json(sanitizeForClient(room));
  };
}

module.exports = { createHandler };
