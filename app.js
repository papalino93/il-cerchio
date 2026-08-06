"use strict";

/* Motore condiviso tra Il Cerchio e I Compiti: questo file è identico nei
   due progetti. Prima di caricarlo, l'HTML deve già aver definito ICONS,
   I18N, COFFEE_URL e VAPID_PUBLIC_KEY (i contenuti specifici del
   progetto) — vedi in cima al file .html. Se lo modifichi, copialo
   nell'altro repo invece di ripetere la modifica a mano. */

/* ========================== 3 · STATO ========================== */
const el = id => document.getElementById(id);
const KEY_SETUP = "cerchio:setup", KEY_ROOM = "cerchio:room", KEY_MYNAME = "cerchio:myname", KEY_MEMBER = "cerchio:memberid";
const store = {
  get(k, f){ try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch { return f; } },
  set(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k){ try { localStorage.removeItem(k); } catch {} }
};

const KEY_LANG = "cerchio:lang";
function defaultLang(){
  const saved = store.get(KEY_LANG, null);
  if (saved === "it" || saved === "en") return saved;
  return (navigator.language || "it").toLowerCase().startsWith("it") ? "it" : "en";
}
let LANG = defaultLang();
const S = () => I18N[LANG].ui;
const TP = () => I18N[LANG].tpl;
let TASKS = I18N[LANG].tasks, WHENS = I18N[LANG].whens, DETAILS = I18N[LANG].details;

let setup = Object.assign({ name:"", place:"", size:0, conditions:"" }, store.get(KEY_SETUP, {}));
let myName = store.get(KEY_MYNAME, "");
let myMemberId = "";
let draft = { task:null, lists:{}, texts:{}, when:null, day:"", words:"" };
let editingTaskId = null;
let room = { _v:"", setup:{ name:"", place:"", size:0, lang:LANG }, tasks:[], members:[], pending:[] };
let ROOM_CODE = "";
let current = null;
let pollTimer = null;
/* Ogni risposta porta la propria versione (_v, basata sull'istante di
   scrittura sul server). Una GET di poll partita prima di un'azione ma
   arrivata dopo può comunque contenere dati leggermente vecchi (piccola
   latenza di propagazione dello storage): confrontando le versioni,
   invece dell'ordine di arrivo in rete, scartiamo sempre chi è più vecchio,
   indipendentemente da quando la risposta arriva. */
async function withRoom(promise){
  const data = await promise;
  if (!room._v || (data._v && data._v >= room._v)) room = data;
  return room;
}

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const buzz = () => { try { navigator.vibrate && navigator.vibrate(12); } catch {} };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));

function rndCode(len){
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

function resolveRoomCode(){
  const q = new URLSearchParams(location.search).get("r");
  if (q && /^[a-z0-9]{4,24}$/i.test(q)){
    store.set(KEY_ROOM, q.toLowerCase());
    return q.toLowerCase();
  }
  const saved = store.get(KEY_ROOM, null);
  const code = saved || rndCode(8);
  if (!saved) store.set(KEY_ROOM, code);
  try {
    const u = new URL(location.href);
    u.searchParams.set("r", code);
    history.replaceState(null, "", u.toString());
  } catch {}
  return code;
}

/* Un link "personale" (?r=codice&m=iltuoid) permette di recuperare il
   proprio posto qui dentro da un telefono nuovo o dopo aver svuotato il
   browser, senza dover richiedere di nuovo l'autorizzazione: il server
   controlla comunque che quell'id sia davvero già tra i membri (vedi
   MEMBER_ONLY in api/_engine.js). */
function resolveMemberId(){
  const params = new URLSearchParams(location.search);
  const m = params.get("m");
  if (m && /^m_[a-z0-9]+$/i.test(m)){
    store.set(KEY_MEMBER, m);
    try {
      const u = new URL(location.href);
      u.searchParams.delete("m");
      history.replaceState(null, "", u.toString());
    } catch {}
    return m;
  }
  let id = store.get(KEY_MEMBER, null);
  if (!id){
    id = "m_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    store.set(KEY_MEMBER, id);
  }
  return id;
}

function roomUrl(){
  const clean = (location.origin + location.pathname).replace(/\?.*$/, "").replace(/#.*$/, "");
  return clean + "?r=" + ROOM_CODE;
}
function personalUrl(){
  return roomUrl() + "&m=" + encodeURIComponent(myMemberId);
}

/* ========================== 4 · API ========================== */
async function apiGet(){
  const res = await fetch(`/api/room?code=${encodeURIComponent(ROOM_CODE)}`, { cache:"no-store" });
  if (!res.ok) throw new Error("get_failed");
  return res.json();
}
async function apiPost(body){
  const res = await fetch(`/api/room?code=${encodeURIComponent(ROOM_CODE)}`, {
    method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ memberId: myMemberId, ...body })
  });
  if (!res.ok) { const err = new Error("post_failed"); err.status = res.status; throw err; }
  return res.json();
}

/* ========================== 4b · APPARTENENZA ========================== */
/* Lo spazio è chiuso: possedere il link basta per chiedere di entrare,
   non per vedere o modificare la bacheca. Lo stato si ricava sempre dai
   dati del server (members/pending), mai da un flag locale. */
function myStatus(){
  if (room.members.some(m => m.id === myMemberId)) return "member";
  if (room.pending.some(p => p.id === myMemberId)) return "pending";
  return "none";
}
function routeByMembership(announce){
  const st = myStatus();
  if (st === "member") go("board", announce);
  else if (st === "pending") go("waiting");
  else go("join");
}

async function loadRoom(silent){
  try {
    await withRoom(apiGet());
    el("warn").hidden = true;
    applyRoomHeader();
    if (current === "board") renderBoard();
    if (current === "waiting" && myStatus() === "member") { go("board", TP().toastBenvenuto); toast(TP().toastBenvenuto); }
    if (current === "settings") { renderMembers(); renderPending(); }
    if (current === "join") paintJoinView();
    return true;
  } catch (e){
    if (!silent){
      el("warn-text").textContent = TP().loadError;
      el("warn").hidden = false;
    }
    return false;
  }
}
function startPolling(){
  stopPolling();
  pollTimer = setInterval(() => { if (!document.hidden) loadRoom(true); }, 6000);
}
function stopPolling(){ if (pollTimer) clearInterval(pollTimer); pollTimer = null; }
document.addEventListener("visibilitychange", () => { if (!document.hidden) loadRoom(true); });

/* Il primissimo arrivo in uno spazio vuoto non sta chiedendo di entrare
   in qualcosa che già esiste: lo sta creando. Il testo della schermata
   di ingresso cambia di conseguenza (vedi createHandler → azione "join"
   in api/_engine.js, dove il primo membro entra senza autorizzazione). */
function paintJoinView(){
  const creating = (room.members || []).length === 0;
  const s = S();
  el("join-eyebrow").textContent = creating ? s.joinEyebrowCreate : s.joinEyebrow;
  el("join-hint").textContent = creating ? s.joinHintCreate : s.joinHint;
  el("btn-join").textContent = creating ? s.joinBtnCreate : s.joinBtn;
}

/* ========================== 5 · NAVIGAZIONE ========================== */
const VIEWS = {
  join:{ v:"v-join", f:"f-joinname" },
  waiting:{ v:"v-waiting", f:"k-waiting" },
  board:{ v:"v-board", f:"btn-add-task" },
  compose:{ v:"v-compose", f:"s1" },
  settings:{ v:"v-settings", f:"k-set" }
};
function go(key, announce){
  const next = VIEWS[key]; if (!next) return;
  const paint = () => {
    Object.values(VIEWS).forEach(x => el(x.v).hidden = true);
    el(next.v).hidden = false;
    const node = el(next.v);
    node.classList.add("enter");
    requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove("enter")));
    window.scrollTo(0, 0);
    setTimeout(() => { try { el(next.f).focus({ preventScroll:true }); } catch {} },
      reduced() ? 0 : 260);
    if (announce) el("live").textContent = announce;
    current = key;
    if (key === "board") renderBoard();
    if (key === "join") { el("f-joinname").value = myName; paintJoinView(); }
    if (key === "settings"){
      el("room-link-display").textContent = roomUrl();
      el("personal-link-display").textContent = personalUrl();
      renderMembers(); renderPending();
    }
  };
  if (current && !reduced()){
    const old = el(VIEWS[current].v);
    old.classList.add("leave");
    setTimeout(() => { old.classList.remove("leave"); paint(); }, 190);
  } else paint();
}

let tTimer = null;
function toast(text){
  const n = el("toast");
  n.textContent = text; n.classList.add("show");
  if (tTimer) clearTimeout(tTimer);
  tTimer = setTimeout(() => n.classList.remove("show"), 4600);
}

/* ========================== 6 · LINGUA ========================== */
function applyStaticI18n(){
  const s = S();
  document.querySelectorAll("[data-i18n]").forEach(n => {
    const k = n.dataset.i18n; if (s[k] != null) n.textContent = s[k];
  });
  document.querySelectorAll("[data-i18n-html]").forEach(n => {
    const k = n.dataset.i18nHtml; if (s[k] != null) n.innerHTML = s[k];
  });
  document.querySelectorAll("[data-i18n-ph]").forEach(n => {
    const k = n.dataset.i18nPh; if (s[k] != null) n.placeholder = s[k];
  });
  document.documentElement.lang = LANG;
  el("lang-switch-header").querySelectorAll("button").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.lang === LANG)));
  el("lang-pair").querySelectorAll("button").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.lang === LANG)));
  el("btn-coffee").href = COFFEE_URL || "#";
  el("coffeeFab").href = COFFEE_URL || "#";
}
function rerenderCurrentView(){
  if (current === "board") renderBoard();
  else if (current === "compose"){ renderComposerLists(); paintDetail(); }
  else if (current === "settings"){ el("room-link-display").textContent = roomUrl(); el("personal-link-display").textContent = personalUrl(); }
  else if (current === "join") paintJoinView();
}
function setLang(l, persist){
  LANG = l;
  if (persist) store.set(KEY_LANG, LANG);
  TASKS = I18N[LANG].tasks; WHENS = I18N[LANG].whens; DETAILS = I18N[LANG].details;
  applyStaticI18n();
}
function applyLang(l){ setLang(l, true); rerenderCurrentView(); }
el("lang-switch-header").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  buzz(); applyLang(b.dataset.lang);
});
el("lang-pair").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  buzz(); applyLang(b.dataset.lang);
});
el("btn-coffee").addEventListener("click", e => {
  if (!COFFEE_URL){ e.preventDefault(); toast(TP().toastCoffeeMissing); }
});
el("coffeeFab").addEventListener("click", e => {
  if (!COFFEE_URL){ e.preventDefault(); toast(TP().toastCoffeeMissing); }
});

/* ========================== 7 · BACHECA ========================== */
function applyRoomHeader(){
  const s = room.setup || {};
  const name = s.name || setup.name || "";
  const place = s.place || setup.place || "";
  const size = s.size || setup.size || 0;
  el("avatar").textContent = (name || "?").charAt(0).toUpperCase();
  el("who").textContent = name || (LANG === "it" ? "La tua famiglia" : "Your family");
  el("meta").textContent = place || "";
  el("count").hidden = !size;
  el("count-label").textContent = TP().countLabel(size);
}

function taskDisplay(t){
  const def = TASKS.find(x => x.id === t.taskType);
  const genericTitle = def ? def.t : t.taskType;
  const title = (t.taskType === "altro" && t.detail) ? t.detail : genericTitle;
  const w = WHENS.find(x => x.id === t.when);
  let whenText = "";
  if (t.when === "giorno" && t.day){
    const d = new Date(t.day + "T12:00:00");
    if (!isNaN(d.getTime())){
      whenText = new Intl.DateTimeFormat(I18N[LANG].locale,
        { weekday:"long", day:"numeric", month:"long", timeZone:"Europe/Rome" }).format(d);
    }
  } else if (w) whenText = w.label;
  const noteParts = [];
  if (t.list && t.list.length) noteParts.push(t.list.join(" · "));
  if (t.taskType !== "altro" && t.detail) noteParts.push(t.detail);
  if (t.note) noteParts.push(t.note);
  return { title, whenText, note: noteParts.join(" — "), icon: (def && def.icon) || "altro" };
}

function taskRow(t){
  const d = taskDisplay(t);
  const metaBits = [d.whenText, d.note].filter(Boolean).join(" · ");
  let actions = "";
  if (t.status === "open"){
    actions = `<button class="chip-btn primary" data-act="claim" data-id="${t.id}">${esc(S().yesBtn)}</button>`;
  } else if (t.status === "claimed"){
    actions = `<button class="chip-btn primary" data-act="done" data-id="${t.id}">${esc(S().doneBtn)}</button>
               <button class="chip-btn" data-act="unclaim" data-id="${t.id}">${esc(S().unclaimBtn)}</button>`;
  } else {
    actions = `<button class="chip-btn" data-act="reopen" data-id="${t.id}">${esc(S().reopenBtn)}</button>`;
  }
  const who = t.status !== "open" && t.claimedBy
    ? `<span class="task-row-who">${esc(TP().turnLabel(t.claimedBy))}</span>` : "";
  const editBtn = t.status === "done" ? "" :
    `<button class="edit-btn" type="button" data-act="edit" data-id="${t.id}" aria-label="${esc(S().editTaskAria)}">
       <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
     </button>`;
  return `<div class="task-row ${t.status === "done" ? "done" : ""}" data-id="${t.id}">
    <div class="task-row-ico">${svg(d.icon)}</div>
    <div class="task-row-body"><b>${esc(d.title)}</b><small>${esc(metaBits)}</small>${who}</div>
    ${editBtn}
    <div class="task-row-actions">${actions}</div>
  </div>`;
}

function renderBoard(){
  const tasks = room.tasks || [];
  const open = tasks.filter(t => t.status === "open").sort((a,b) => a.createdAt - b.createdAt);
  const claimed = tasks.filter(t => t.status === "claimed").sort((a,b) => a.createdAt - b.createdAt);
  const done = tasks.filter(t => t.status === "done").sort((a,b) => (b.doneAt||0) - (a.doneAt||0));

  el("list-open").innerHTML = open.map(taskRow).join("");
  el("empty-open").hidden = open.length !== 0;
  el("blk-claimed").hidden = claimed.length === 0;
  el("list-claimed").innerHTML = claimed.map(taskRow).join("");
  el("blk-done").hidden = done.length === 0;
  el("list-done").innerHTML = done.map(taskRow).join("");
}

function boardAction(e){
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act, id = b.dataset.id;
  buzz();
  if (act === "edit"){
    const t = (room.tasks || []).find(x => x.id === id);
    if (t) openEditTask(t);
    return;
  }
  const anon = LANG === "it" ? "Qualcuno" : "Someone";
  let p;
  if (act === "claim") p = apiPost({ action:"claim", id, by: myName || anon });
  else if (act === "unclaim") p = apiPost({ action:"unclaim", id });
  else if (act === "reopen") p = apiPost({ action:"reopen", id });
  else if (act === "done") p = apiPost({ action:"done", id });
  else return;
  withRoom(p).then(() => renderBoard()).catch(() => toast(TP().loadError));
}
["list-open","list-claimed","list-done"].forEach(id => el(id).addEventListener("click", boardAction));

el("btn-clear-done").onclick = () => {
  buzz();
  withRoom(apiPost({ action:"clearDone" })).then(() => renderBoard()).catch(() => toast(TP().loadError));
};

/* window.open() da solo viene bloccato da diversi browser/estensioni
   quando arriva da un handler asincrono. Un vero <a> cliccato è quello
   che i blocchi popup lasciano passare più spesso: lo usiamo come
   percorso principale su desktop, con la copia negli appunti come
   ultima rete di sicurezza se anche quello fallisce. */
async function share(text){
  if (navigator.share){
    try { await navigator.share({ text }); return "shared"; }
    catch (err){ if (err && (err.name === "AbortError" || err.name === "NotAllowedError")) return "cancelled"; }
  }
  const url = "https://wa.me/?text=" + encodeURIComponent(text);
  let opened = false;
  try {
    const a = document.createElement("a");
    a.href = url; a.target = "_blank"; a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    opened = true;
  } catch {}
  if (!opened){
    const w = window.open(url, "_blank", "noopener");
    opened = !!w;
  }
  if (!opened) copy(text, TP().toastMessaggioCopiato);
  return opened ? "opened" : "copied";
}
async function copy(text, msg){
  try { await navigator.clipboard.writeText(text); toast(msg || TP().toastCopiato); }
  catch {
    const a = document.createElement("textarea");
    a.value = text; a.style.position = "fixed"; a.style.opacity = "0";
    document.body.appendChild(a); a.select();
    try { document.execCommand("copy"); toast(msg || TP().toastCopiato); }
    catch { toast(TP().toastCopiaFallita); }
    a.remove();
  }
}
el("btn-share-board").onclick = () => { buzz(); share(TP().shareRoomMsg(roomUrl())); };
el("btn-share-room").onclick  = () => { buzz(); share(TP().shareRoomMsg(roomUrl())); };
el("btn-copy-room").onclick   = () => { buzz(); copy(roomUrl(), TP().toastLinkCopiato); };
el("btn-copy-personal").onclick  = () => { buzz(); copy(personalUrl(), TP().toastLinkCopiato); };
el("btn-share-personal").onclick = () => { buzz(); share(personalUrl()); };

/* ========================== 8 · COMPOSITORE ========================== */
function renderComposerLists(){
  el("tiles").innerHTML = TASKS.map(t =>
    `<button class="tile" type="button" data-id="${t.id}" aria-pressed="false">
       <span class="tile-head">${svg(t.icon)}<span class="tick" aria-hidden="true" hidden>✓</span></span>
       <span class="tile-body"><b>${esc(t.t)}</b><small>${esc(t.h)}</small></span>
     </button>`).join("");
  el("whens").innerHTML = WHENS.map(w =>
    `<button class="chip" type="button" data-id="${w.id}" aria-pressed="false">${esc(w.label)}</button>`).join("");
  Array.from(el("tiles").children).forEach(x => {
    const on = x.dataset.id === draft.task;
    x.setAttribute("aria-pressed", String(on));
    x.querySelector(".tick").hidden = !on;
  });
  Array.from(el("whens").children).forEach(x =>
    x.setAttribute("aria-pressed", String(x.dataset.id === draft.when)));
}

function resetComposer(){
  editingTaskId = null;
  draft = { task:null, lists:{}, texts:{}, when:null, day:"", words:"" };
  el("f-words").value = ""; el("f-day").value = "";
  el("d-value").value = ""; el("d-draft").value = "";
  el("day-wrap").hidden = true; el("detail").hidden = true;
  el("btn-send").textContent = S().addTaskBtn;
  renderComposerLists();
}

function openEditTask(t){
  editingTaskId = t.id;
  draft = { task:t.taskType, lists:{}, texts:{}, when:t.when || null, day:t.day || "", words:t.note || "" };
  const cfg = DETAILS[t.taskType];
  if (cfg && cfg.kind === "list") draft.lists[t.taskType] = [...(t.list || [])];
  else draft.texts[t.taskType] = t.detail || "";
  renderComposerLists();
  paintDetail();
  el("f-words").value = draft.words;
  el("f-day").value = draft.day;
  el("day-wrap").hidden = draft.when !== "giorno";
  el("btn-send").textContent = S().editTaskBtn;
  go("compose");
}

function buildComposer(){
  renderComposerLists();
  el("tiles").addEventListener("click", e => {
    const b = e.target.closest(".tile"); if (!b) return;
    buzz(); draft.task = b.dataset.id;
    Array.from(el("tiles").children).forEach(x => {
      const on = x === b;
      x.setAttribute("aria-pressed", String(on));
      x.querySelector(".tick").hidden = !on;
    });
    paintDetail();
  });
  el("whens").addEventListener("click", e => {
    const b = e.target.closest(".chip"); if (!b) return;
    buzz(); draft.when = b.dataset.id;
    Array.from(el("whens").children).forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    const pick = draft.when === "giorno";
    el("day-wrap").hidden = !pick;
    if (pick) el("f-day").focus();
  });
  el("d-add").onclick = addItem;
  el("d-draft").addEventListener("keydown", e => {
    if (e.key === "Enter"){ e.preventDefault(); addItem(); }
  });
  el("d-value").addEventListener("input", e => { draft.texts[draft.task] = e.target.value; });
  el("f-day").addEventListener("input", e => { draft.day = e.target.value; });
  el("f-words").addEventListener("input", e => { draft.words = e.target.value; });
}

const MAX_VOCE = 80;
function addItem(){
  let v = el("d-draft").value.trim();
  if (!v || !draft.task) return;
  if (v.length > MAX_VOCE){ v = v.slice(0, MAX_VOCE).trim(); toast(TP().toastVoceAccorciata); }
  const gia = draft.lists[draft.task] = draft.lists[draft.task] || [];
  if (gia.some(x => x.toLowerCase() === v.toLowerCase())){
    el("d-draft").value = ""; toast(TP().toastGiaLista); return;
  }
  gia.push(v);
  el("d-draft").value = ""; el("d-draft").focus();
  paintDetail();
}

function paintDetail(){
  const cfg = DETAILS[draft.task];
  el("detail").hidden = !cfg;
  if (!cfg) return;
  el("d-label").textContent = cfg.label;
  el("d-list").hidden = cfg.kind !== "list";
  el("d-text").hidden = cfg.kind !== "text";
  if (cfg.kind === "list"){
    const items = draft.lists[draft.task] || [];
    el("d-meta").textContent = items.length ? TP().itemCount(items.length) : (LANG === "it" ? "Facoltativo" : "Optional");
    el("d-items").innerHTML = items.map((x,i) =>
      `<div class="item"><span class="dot" aria-hidden="true"></span>
         <span class="txt">${esc(x)}</span>
         <button class="rm" type="button" data-i="${i}" aria-label="${LANG === "it" ? "Togli" : "Remove"} ${esc(x)}">×</button></div>`).join("");
    el("d-items").querySelectorAll(".rm").forEach(b => b.onclick = () => {
      draft.lists[draft.task].splice(+b.dataset.i, 1);
      paintDetail();
    });
    el("d-draft").placeholder = cfg.ph;
  } else {
    el("d-meta").textContent = LANG === "it" ? "Facoltativo" : "Optional";
    el("d-value").value = draft.texts[draft.task] || "";
    el("d-value").placeholder = cfg.ph;
    el("d-note").textContent = cfg.note || "";
  }
}

el("btn-add-task").onclick = () => { buzz(); resetComposer(); go("compose"); };
el("btn-cancel-compose").onclick = () => { buzz(); editingTaskId = null; el("btn-send").textContent = S().addTaskBtn; go("board"); };

el("btn-send").onclick = async () => {
  if (!draft.task){ buzz(); toast(TP().hintNeedTask); return; }
  buzz();
  const cfg = DETAILS[draft.task] || {};
  const task = {
    taskType: draft.task,
    when: draft.when || "",
    day: draft.day || "",
    detail: cfg.kind === "text" ? (draft.texts[draft.task] || "").trim() : "",
    list: cfg.kind === "list" ? (draft.lists[draft.task] || []) : [],
    note: (draft.words || "").trim(),
    lang: LANG
  };
  try {
    if (editingTaskId){
      await withRoom(apiPost({ action:"editTask", id:editingTaskId, task }));
      editingTaskId = null;
      el("btn-send").textContent = S().addTaskBtn;
      go("board", S().announceSalvato);
      toast(S().announceSalvato);
    } else {
      await withRoom(apiPost({ action:"addTask", task }));
      go("board", TP().announceAggiunto);
      toast(TP().announceAggiunto);
      const d = taskDisplay(task);
      showNudge(TP().shareTaskMsg(d.title, d.whenText, roomUrl()));
    }
  } catch (e){
    toast(TP().loadError);
  }
};

/* ========================== 9b · AVVISO WHATSAPP ========================== */
let pendingNudgeMsg = "";
function showNudge(msg){
  pendingNudgeMsg = msg;
  el("nudge-box").hidden = false;
}
function hideNudge(){ el("nudge-box").hidden = true; pendingNudgeMsg = ""; }
el("btn-nudge-share").onclick = () => { buzz(); share(pendingNudgeMsg); hideNudge(); };
el("btn-nudge-skip").onclick  = () => { buzz(); hideNudge(); };
el("btn-nudge-join").onclick  = () => { buzz(); share(TP().shareJoinMsg(roomUrl())); };

/* ========================== 9 · IMPOSTAZIONI ========================== */
function openSettings(){
  buzz();
  el("f-myname").value = myName;
  el("f-name").value = setup.name;
  el("f-place").value = setup.place;
  el("f-size").value = setup.size;
  el("f-cond").value = setup.conditions;
  el("room-link-display").textContent = roomUrl();
  el("personal-link-display").textContent = personalUrl();
  refreshNotifyUI();
  go("settings");
}
el("btn-settings").onclick = openSettings;
el("btn-back-board").onclick = () => { buzz(); go("board"); };

/* ========================== 9c · NOTIFICHE PUSH ========================== */
/* VAPID_PUBLIC_KEY è definita nell'HTML, prima di questo file (è l'unica
   chiave che cambia da un progetto all'altro). */
function urlBase64ToUint8Array(base64String){
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
function isIOS(){ return /iP(hone|od|ad)/.test(navigator.userAgent); }
function isStandalone(){ return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true; }
function pushSupported(){ return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; }

let swRegistration = null;
async function registerSW(){
  if (!("serviceWorker" in navigator)) return null;
  try { swRegistration = await navigator.serviceWorker.register("/sw.js"); return swRegistration; }
  catch { return null; }
}

async function refreshNotifyUI(){
  el("notify-off").hidden = true;
  el("notify-on").hidden = true;
  el("notify-ios-hint").hidden = true;
  el("notify-unsupported").hidden = true;
  el("notify-denied").hidden = true;

  if (isIOS() && !isStandalone()){ el("notify-ios-hint").hidden = false; return; }
  if (!pushSupported()){ el("notify-unsupported").hidden = false; return; }
  if (Notification.permission === "denied"){ el("notify-denied").hidden = false; return; }
  if (Notification.permission === "granted" && swRegistration){
    try {
      const sub = await swRegistration.pushManager.getSubscription();
      if (sub){ el("notify-on").hidden = false; return; }
    } catch {}
  }
  el("notify-off").hidden = false;
}

el("btn-notify-on").onclick = async () => {
  buzz();
  if (!pushSupported()) return;
  if (!swRegistration) await registerSW();
  if (!swRegistration) { toast(TP().loadError); return; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted"){ refreshNotifyUI(); return; }
    const sub = await swRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    });
    await apiPost({ action:"savePush", sub: sub.toJSON() });
    toast(TP().toastNotifyOn);
  } catch (e){ toast(TP().loadError); }
  refreshNotifyUI();
};

el("btn-notify-off").onclick = async () => {
  buzz();
  try {
    if (swRegistration){
      const sub = await swRegistration.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    }
    await apiPost({ action:"removePush" });
    toast(TP().toastNotifyOff);
  } catch (e){}
  refreshNotifyUI();
};

el("btn-save").onclick = async () => {
  buzz();
  myName = el("f-myname").value.trim();
  store.set(KEY_MYNAME, myName);
  setup = {
    name: el("f-name").value.trim(),
    place: el("f-place").value.trim(),
    size: Math.max(0, Math.min(30, parseInt(el("f-size").value, 10) || 0)),
    conditions: el("f-cond").value.trim()
  };
  store.set(KEY_SETUP, setup);
  try {
    await withRoom(apiPost({ action:"saveSetup", setup:{ name:setup.name, place:setup.place, size:setup.size, lang:LANG } }));
  } catch (e){}
  applyRoomHeader();
  go("board", TP().announceImpostazioniSalvate);
  toast(TP().toastSalvatoOk);
};

/* ========================== 9b · MEMBRI ========================== */
function renderMembers(){
  const list = room.members || [];
  el("members-list").innerHTML = list.map(m => {
    const you = m.id === myMemberId;
    const actions = you ? "" : `<div class="task-row-actions">
        <button class="chip-btn" data-act="removeMember" data-id="${m.id}">${esc(S().removeBtn)}</button>
      </div>`;
    return `<div class="task-row"><div class="task-row-body"><b>${esc(m.name)}${you ? ` <span class="task-row-who">(${esc(S().youTag)})</span>` : ""}</b></div>${actions}</div>`;
  }).join("") || `<p class="board-empty">—</p>`;
}
el("members-list").addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  buzz();
  // doppio tap di conferma: il primo tap chiede "sicuro?", il secondo
  // (entro pochi secondi) rimuove davvero. Evita rimozioni per sbaglio
  // senza dover aggiungere una finestra di dialogo.
  if (b.dataset.confirm !== "1"){
    b.dataset.confirm = "1";
    b.textContent = S().removeConfirmBtn;
    b.__confirmTimer = setTimeout(() => { b.dataset.confirm = ""; b.textContent = S().removeBtn; }, 3000);
    return;
  }
  clearTimeout(b.__confirmTimer);
  withRoom(apiPost({ action:"removeMember", id:b.dataset.id }))
    .then(() => { renderMembers(); toast(S().toastMemberRemoved); })
    .catch(() => toast(TP().loadError));
});
function renderPending(){
  const list = room.pending || [];
  el("pending-box").hidden = list.length === 0;
  el("pending-list").innerHTML = list.map(p =>
    `<div class="task-row">
       <div class="task-row-body"><b>${esc(p.name)}</b></div>
       <div class="task-row-actions">
         <button class="chip-btn primary" data-act="approve" data-id="${p.id}">${esc(S().approveBtn)}</button>
         <button class="chip-btn" data-act="deny" data-id="${p.id}">${esc(S().denyBtn)}</button>
       </div>
     </div>`
  ).join("");
}
el("pending-list").addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  buzz();
  withRoom(apiPost({ action:b.dataset.act, id:b.dataset.id }))
    .then(() => { renderMembers(); renderPending(); })
    .catch(() => toast(TP().loadError));
});

el("btn-leave-circle").onclick = async () => {
  buzz();
  try { await withRoom(apiPost({ action:"leave" })); } catch (e){}
  stopPolling();
  store.del(KEY_ROOM); store.del(KEY_MEMBER);
  try {
    const u = new URL(location.href);
    u.searchParams.delete("r");
    history.replaceState(null, "", u.toString());
  } catch {}
  location.reload();
};

/* ========================== 9d · INGRESSO ========================== */
el("btn-join").onclick = async () => {
  const name = el("f-joinname").value.trim();
  if (!name){ buzz(); el("f-joinname").focus(); return; }
  buzz();
  myName = name; store.set(KEY_MYNAME, name);
  try {
    await withRoom(apiPost({ action:"join", id:myMemberId, name }));
    toast(myStatus() === "member" ? TP().toastBenvenuto : TP().toastRichiestaInviata);
    routeByMembership();
    if (myStatus() === "member") applyRoomHeader();
  } catch (e){ toast(TP().loadError); }
};
el("btn-cancel-join").onclick = async () => {
  buzz();
  try { await withRoom(apiPost({ action:"cancelJoin", id:myMemberId })); } catch (e){}
  go("join");
};

/* ========================== 10 · AVVIO ========================== */
applyStaticI18n();
buildComposer();
ROOM_CODE = resolveRoomCode();
myMemberId = resolveMemberId();
applyRoomHeader();
registerSW();
loadRoom(false).then(() => routeByMembership());
startPolling();
