(() => {
'use strict';
const E = window.CDERT;
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = E.uid, LEVELS = E.LEVELS, INC = E.INC, KINDS = E.KINDS, geo = E.geo, lvlRaw = E.lvlRaw;
const ICON = { medical: '🏥', shelter: '⛺', water: '💧', police: '🛡️', lost: '🔎' };
const FCOL = { medical: '--rose-line', shelter: '--mint-line', water: '--sky-line', police: '--accent', lost: '--butter-line' };
const ROLES = {
  visitor: { label: 'Visitor', desc: 'Safety information, nearest help and SOS.' },
  volunteer: { label: 'Volunteer', desc: 'Receives task offers, reports incidents and crowd readings, updates shelters and water points.' },
  medical: { label: 'Medical team', desc: 'Receives medical tasks and updates beds and ambulances.' },
  admin: { label: 'Administrator', desc: 'Dispatches responders, broadcasts notices and runs the control room.' }
};
const QUICK = { visitor: null, volunteer: 'R1', medical: 'R5', admin: 'admin' };

/* ------------------------------------------------------------ storage */
const mk = st => ({ get(k, d) { try { const v = st.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }, set(k, v) { try { st.setItem(k, JSON.stringify(v)); } catch (e) { /* quota */ } }, del(k) { try { st.removeItem(k); } catch (e) { /* ignore */ } } });
const LS = mk(window.localStorage), SS = mk(window.sessionStorage);
const ANON = { id: 'anon', name: 'Visitor', role: 'visitor', token: null };
let ME = SS.get('cdert-me', ANON);
const CLIENT = SS.get('cdert-cid', null) || (() => { const c = uid(); SS.set('cdert-cid', c); return c; })();
const K = n => `cdert-${n}-${ME.id}`;

/* -------------------------------------------------------------- state */
let D = LS.get(K('cache'), null);        // last snapshot from the server
let OUT = LS.get(K('out'), []);          // outbox: updates made but not yet acknowledged
let LOG = LS.get(K('log'), []);          // human-readable update log
let USERS = LS.get('cdert-users', []);
let V = null;                            // view = snapshot + outbox replayed (what the person sees)
let MYLOC = LS.get('cdert-myloc', { x: 420, y: 300 });
let MYSOS = LS.get('cdert-mysos', []);
let BUL = (D && D.bulletin) || null, PEER = null, transport = 'sse', skew = 0, ff = 0, simOffline = false, netFail = false, lastSync = D ? D.serverTime : 0, es = null, busy = false;
const seenOffers = new Set(), peers = {};
const UI = { tab: 'overview', selZone: null, selFac: null, pick: null, layers: { density: true, fac: true, paths: true, desig: true, inc: true, team: true }, zoneDraft: null,
  inc: { type: 'Medical emergency', sev: 2, note: '', x: null, y: null }, reporting: false, sos: { type: 'Medical help', note: '' }, bc: { level: 2, text: '' },
  syncing: false, lang: 'en', pack: null, flash: null, surgeZone: 'Z1', route: null, pnote: '', assignSel: {}, tdraft: { title: '', skill: 'crowd', priority: 2, x: null, y: null }, creating: false };

const now = () => Date.now() + skew;
const disp = () => now() + ff;
const online = () => !simOffline && !netFail;
const ago = ts => { const s = Math.max(0, Math.round((disp() - ts) / 1000)); if (s < 45) return 'just now'; const m = Math.round(s / 60); return m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };
const fresh = ts => { const m = (disp() - ts) / 60000; return m < 2 ? ['fresh', 'Fresh'] : m < 10 ? ['aging', 'Aging'] : ['stale', 'Stale']; };
const clock = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const can = k => (E.PERM[k] || []).includes(ME.role);
const isResp = () => ME.role === 'volunteer' || ME.role === 'medical';
const meR = () => V && V.responders.find(r => r.id === ME.id);
const myPos = () => { const r = isResp() && meR(); return r ? { x: r.x, y: r.y } : MYLOC; };
const zoneAt = (x, y) => E.zoneAt(V, x, y);
const rname = id => { const r = V && V.responders.find(k => k.id === id); return r ? r.name : id; };

/* --------------------------------------------------------- networking */
async function api(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (ME.token) headers.Authorization = 'Bearer ' + ME.token;
  let r;
  try { r = await fetch(path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' }); }
  catch (e) { netFail = true; throw e; }
  netFail = false;
  if (r.status === 401 && ME.token) { toast('Your session ended. Signed out.'); await signOut(true); throw new Error('unauthorised'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error(j.error || 'Request failed'); err.status = r.status; throw err; }
  return j;
}
function setSnapshot(s) {
  D = s; if (s.bulletin) BUL = s.bulletin; skew = s.serverTime - Date.now(); lastSync = now();
  LS.set(K('cache'), s);
  recompute();
  if (isResp()) {
    V.tasks.filter(t => t.status === 'offered' && t.offeredTo === ME.id && !seenOffers.has(t.id + t.offerExpires)).forEach(t => {
      seenOffers.add(t.id + t.offerExpires);
      toast('New task offered: ' + t.title);
      if (navigator.vibrate) navigator.vibrate([150, 80, 150]);
    });
  }
  renderLive();
}
function recompute() {
  if (!D) { V = null; return; }
  V = E.clone(D);
  OUT.forEach(op => E.applyOp(V, op, ME, { optimistic: true, now: now() }));
  if (UI.route) replan();
}
async function loadState() { try { setSnapshot(await api('/api/state')); } catch (e) { /* offline */ } }
function connect() {
  if (es) { es.close(); es = null; }
  if (!online() || !window.EventSource || transport === 'poll') return;
  es = new EventSource('/api/events' + (ME.token ? '?token=' + ME.token : ''));
  es.onmessage = ev => { netFail = false; try { setSnapshot(JSON.parse(ev.data)); } catch (e) { /* ignore */ } if (OUT.length) flush(); };
  es.onerror = () => { if (es) { es.close(); es = null; } netFail = true; renderHeader(); };
}
async function flush() {
  if (busy || !OUT.length || !online()) return;
  busy = true;
  const batch = OUT.slice();
  try {
    const r = await api('/api/sync', { clientId: CLIENT, ops: batch });
    const ids = new Set(batch.map(o => o.id));
    OUT = OUT.filter(o => !ids.has(o.id)); LS.set(K('out'), OUT);
    let late = 0, rejected = 0;
    r.results.forEach(x => {
      const l = LOG.find(k => k.id === x.id);
      if (l) { if (l.state === 'pending') late++; l.state = x.ok ? 'synced' : 'rejected'; l.msg = x.ok ? (x.code === 'late-accepted' ? 'Accepted offline; honoured on sync' : '') : x.msg; }
      if (!x.ok) { rejected++; toast('Not applied: ' + x.msg); }
    });
    LS.set(K('log'), LOG);
    setSnapshot(r.snapshot);
    if (late && !rejected) toast(`Synced ${late} update${late > 1 ? 's' : ''} saved while offline.`);
  } catch (e) { /* stays in outbox */ }
  busy = false;
  renderAll();
}
async function resync() {
  UI.syncing = true; renderHeader();
  try { const h = await (await fetch('/api/health', { cache: 'no-store' })).json(); transport = h.transport || 'sse'; netFail = false; } catch (e) { netFail = true; }
  try { const k = await (await fetch('/api/pubkey', { cache: 'no-store' })).json(); if (k && k.jwk) LS.set('cdert-pubkey', k.jwk); } catch (e) { /* keep cached key */ }
  await flush(); await loadState(); connect();
  UI.syncing = false; renderAll();
}
async function heartbeat() {
  if (!online()) announce();
  if (simOffline) return;
  if (transport === 'poll') { if (document.hidden) return; await loadState(); await flush(); if (netFail) renderHeader(); return; }
  if (netFail || !es) {
    try { await fetch('/api/health', { cache: 'no-store' }); const was = netFail || !es; netFail = false; if (was) await resync(); }
    catch (e) { netFail = true; renderHeader(); }
  } else if (!window.EventSource) await loadState();
}
/* ---- nearby-device sharing: signed bulletins (demo transport: BroadcastChannel between tabs of this browser) */
const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('cdert-nearby') : null;
async function verifyBulletin(b) {
  const jwk = LS.get('cdert-pubkey', null);
  if (!jwk || !b || !b.payload || !b.sig || !window.crypto || !window.crypto.subtle) return null;
  try {
    const key = await window.crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const sig = Uint8Array.from(atob(b.sig), c => c.charCodeAt(0));
    const ok = await window.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, new TextEncoder().encode(b.payload));
    return ok ? JSON.parse(b.payload) : null;
  } catch (e) { return null; }
}
async function acceptBulletin(b) {
  if (!D) return;
  const p = await verifyBulletin(b);
  if (!p) return;
  if (p.ts <= (D.bulletinTs || (D.bulletin && JSON.parse(D.bulletin.payload).ts) || 0)) return;
  const nd = E.clone(D);
  p.zones.forEach(bz => { const z = nd.zones.find(k => k.id === bz.id); if (z && bz.updated > z.updated) { z.d = bz.d; z.level = bz.level; z.updated = bz.updated; z.source = bz.source + ' · via nearby device'; } });
  const have = new Set(nd.alerts.map(a => a.id));
  nd.alerts = p.alerts.filter(a => !have.has(a.id)).concat(nd.alerts).sort((a, c) => c.ts - a.ts).slice(0, 30);
  nd.gates = p.gates; nd.evac = p.evac;
  (nd.routes || []).forEach(r => { const br = p.routes.find(k => k.id === r.id); if (br) r.status = br.status; });
  nd.bulletin = b; nd.bulletinTs = p.ts; BUL = b;
  D = nd; LS.set(K('cache'), D); PEER = { ts: Date.now() };
  recompute(); toast('Updated from a nearby device (signed by the control room).'); renderLive();
}
if (bc) bc.onmessage = ev => {
  const m = ev.data; if (!m || m.from === CLIENT) return;
  peers[m.from] = Date.now();
  if (m.type === 'hello' && BUL) bc.postMessage({ type: 'bulletin', from: CLIENT, bul: BUL });
  else if (m.type === 'bulletin' && !online()) acceptBulletin(m.bul);
};
function announce() { if (bc) bc.postMessage({ type: 'hello', from: CLIENT }); }
function setSimOffline(v) {
  simOffline = v;
  if (v) { if (es) { es.close(); es = null; } toast('Offline mode. You see the last synced data; updates are stored on this device.'); renderAll(); }
  else { toast('Reconnecting…'); resync(); }
}

/* ----------------------------------------------------------- operations */
function describe(op) {
  const p = op.p;
  switch (op.type) {
    case 'incident.create': return (p.sos ? 'SOS: ' : 'Incident: ') + p.type;
    case 'incident.status': return 'Incident marked ' + String(p.status).toLowerCase();
    case 'zone.reading': return 'Crowd reading ' + (+p.d).toFixed(1) + ' per m²';
    case 'fac.update': { const f = V && V.fac.find(k => k.id === p.id); return (f ? f.name : p.id) + ': ' + p.field + ' = ' + p.value; }
    case 'alert.broadcast': return 'Broadcast notice';
    case 'task.create': return 'New task: ' + p.title;
    case 'task.assign': return p.responderId ? 'Assigned task to ' + rname(p.responderId) : 'Re-dispatched task';
    case 'task.respond': return p.accept ? 'Accepted task' : 'Declined task';
    case 'task.progress': return 'Task is now ' + p.status;
    case 'task.cancel': return 'Cancelled task';
    case 'vol.update': return p.x != null ? 'Location update' : (p.onDuty ? 'Went on duty' : 'Went off duty');
    case 'settings.update': return 'Changed dispatch settings';
    default: return op.type;
  }
}
function emit(type, p) {
  if (!V) { toast('No data yet. Connect once to download the offline pack.'); return null; }
  const op = { id: uid() + uid(), type, p, ts: now() };
  const test = E.clone(V);
  const r = E.applyOp(test, op, ME, { optimistic: true, now: now() });
  if (!r.ok) { toast(r.msg); return null; }
  const wasOnline = online();
  OUT.push(op); LS.set(K('out'), OUT);
  LOG.unshift({ id: op.id, ts: op.ts, kind: type.split('.')[0], summary: describe(op), state: wasOnline ? 'sending' : 'pending' });
  LOG = LOG.slice(0, 40); LS.set(K('log'), LOG);
  recompute();
  flush();
  return op;
}

/* ----------------------------------------------------------------- auth */
async function loadUsers() {
  try { USERS = await api('/api/users'); LS.set('cdert-users', USERS); } catch (e) { /* cached */ }
  renderHeader();
}
function switchTo(user) {
  ME = user; SS.set('cdert-me', ME);
  D = LS.get(K('cache'), null); OUT = LS.get(K('out'), []); LOG = LS.get(K('log'), []);
  UI.route = null; UI.selZone = UI.selFac = null; UI.reporting = false; UI.tab = 'overview'; seenOffers.clear();
  recompute();
}
async function signIn(userId) {
  const u = USERS.find(x => x.id === userId);
  if (!u) return;
  let pin = u.pinHint;
  if (!pin) pin = window.prompt('PIN for ' + u.name + ':');
  if (!pin) return;
  try {
    const r = await api('/api/login', { userId, pin });
    if (es) { es.close(); es = null; }
    switchTo({ ...r.user, token: r.token });
    toast('Signed in as ' + r.user.name);
    renderAll(); await resync();
  } catch (e) { toast(e.status ? e.message : 'You need a connection to sign in.'); }
}
async function signOut(silent) {
  try { if (ME.token && online()) await api('/api/logout', {}); } catch (e) { /* ignore */ }
  if (es) { es.close(); es = null; }
  switchTo(ANON);
  renderAll(); await resync();
  if (!silent) toast('Signed out. You are browsing as a visitor.');
}

/* -------------------------------------------------------------- routing */
function setRoute(spec, silent) {
  spec = { service: isResp(), ...spec };
  const r = V && E.computeRoute(V, spec);
  if (!r) { UI.route = null; if (!silent) toast('No reachable ' + (spec.kind ? KINDS[spec.kind].toLowerCase() : 'destination') + ' right now.'); return; }
  UI.route = r;
}
function replan() {
  const old = UI.route.key;
  const spec = { ...UI.route.spec };
  const mp = spec.follow ? myPos() : null;
  if (mp) { spec.x = mp.x; spec.y = mp.y; }
  const r = E.computeRoute(V, spec);
  if (r) { if (r.key !== old && !UI.routeQuiet) toast('Route re-planned after conditions changed.'); UI.route = r; }
}

/* -------------------------------------------------------------- actions */
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 3600); }
const ACT = {
  role(el) { const id = QUICK[el.dataset.v]; if (!id) return signOut(); return signIn(id); },
  net() { setSimOffline(!simOffline); },
  tab(el) { UI.tab = el.dataset.v; },
  layer(el) { UI.layers[el.dataset.v] = !UI.layers[el.dataset.v]; },
  pick(el) { UI.pick = el.dataset.v; toast('Tap the map to choose a location.'); },
  cancelPick() { UI.pick = null; },
  near(el) { const p = myPos(); setRoute({ x: p.x, y: p.y, kind: el.dataset.v, label: 'From your location', follow: true }); },
  clearRoute() { UI.route = null; },
  sos() {
    const map = { 'Medical help': ['Medical emergency', 2], 'Lost or separated': ['Missing person', 1], 'Crowd pressure': ['Crowd crush risk', 3], 'Fire or smoke': ['Fire', 3] };
    const [type, sev] = map[UI.sos.type]; const p = myPos();
    const sid = 'INC-' + uid();
    const op = emit('incident.create', { id: sid, type, sev, x: p.x, y: p.y, note: UI.sos.note || 'SOS from visitor app.', sos: true });
    if (!op) return;
    MYSOS.unshift(sid); MYSOS = MYSOS.slice(0, 10); LS.set('cdert-mysos', MYSOS);
    UI.sos.note = '';
    setRoute({ x: p.x, y: p.y, kind: INC[type].kind, label: 'SOS guidance' }, true);
    toast(online() ? 'SOS sent. The nearest responder is being alerted.' : 'SOS saved on this device and will send as soon as you have signal. Follow the route shown.');
  },
  reportToggle() { UI.reporting = !UI.reporting; if (UI.reporting && UI.inc.x == null) { const p = myPos(); UI.inc.x = p.x; UI.inc.y = p.y; } },
  incSev(el) { UI.inc.sev = +el.dataset.v; },
  reportSubmit() { const o = UI.inc; if (emit('incident.create', { id: 'INC-' + uid(), type: o.type, sev: o.sev, x: o.x, y: o.y, note: o.note || 'No details added.' })) { UI.reporting = false; o.note = ''; toast(online() ? 'Incident reported.' : 'Incident saved on this device. It will sync when online.'); } },
  incLocate(el) { const i = V.inc.find(x => x.id === el.dataset.id); if (i) { UI.flash = { x: i.x, y: i.y, until: Date.now() + 3500 }; setTimeout(() => { UI.flash = null; renderMap(); }, 3600); } },
  incEvac(el) { const i = V.inc.find(x => x.id === el.dataset.id); if (i) setRoute({ x: i.x, y: i.y, kind: INC[i.type].kind, label: 'Evacuation from ' + i.type.toLowerCase() }); },
  incStatus(el) { emit('incident.status', { id: el.dataset.id, status: el.dataset.v }); },
  incDispatch(el) {
    const i = V.inc.find(x => x.id === el.dataset.id); if (!i) return;
    if (emit('task.create', { id: 'T-' + uid(), incidentId: i.id, title: `${i.type} in ${zoneAt(i.x, i.y).name}`, skill: INC[i.type].skill, x: i.x, y: i.y, priority: i.sev, note: i.note })) { UI.tab = 'tasks'; toast('Task created. Finding the nearest available responder…'); }
  },
  step(el) {
    const f = V.fac.find(x => x.id === el.dataset.id), fld = el.dataset.f, dl = +el.dataset.d;
    const max = { free: f.beds, ambFree: f.amb, occ: f.cap }[fld];
    emit('fac.update', { id: f.id, field: fld, value: Math.max(0, Math.min(max, f[fld] + dl)) });
  },
  water(el) { emit('fac.update', { id: el.dataset.id, field: 'status', value: el.dataset.v }); },
  zoneSubmit() { const z = V.zones.find(x => x.id === UI.selZone); if (z && emit('zone.reading', { id: z.id, d: UI.zoneDraft })) toast(online() ? 'Reading shared.' : 'Reading saved on this device.'); },
  zoneDetails() { UI.tab = 'overview'; },
  gate(el) { emit('zone.gate', { id: el.dataset.id, closed: el.dataset.v === '1' }); },
  routeSet(el) { emit('route.set', { id: el.dataset.id, status: el.dataset.v }); },
  evacIssue(el) { if (emit('evac.order', { zoneId: el.dataset.id })) toast('Evacuation order issued. Entry to the zone is now closed.'); },
  evacClear(el) { emit('evac.clear', { zoneId: el.dataset.id }); },
  evacMe(el) {
    const e = V.evac[el.dataset.id]; if (!e || !e.assign.length) return toast('No shelter space is listed. Follow the marshals.');
    const p = myPos(); setRoute({ x: p.x, y: p.y, kind: 'shelter', only: e.assign[0].id, label: 'Evacuation route', follow: true });
  },
  rec(el) {
    const z = V.zones.find(k => k.id === el.dataset.z); if (!z) return;
    const t = el.dataset.t;
    if (t === 'gate') emit('zone.gate', { id: z.id, closed: true });
    else if (t === 'evac') { UI.selZone = z.id; UI.zoneDraft = +z.d.toFixed(1); UI.tab = 'overview'; }
    else if (t === 'task') emit('task.create', { id: 'T-' + uid(), title: 'Crowd control at ' + z.name, skill: 'crowd', x: Math.round(z.x + z.w / 2), y: Math.round(z.y + z.h / 2), priority: 2, note: 'Raised from a recommended action.' });
  },
  lang(el) { UI.lang = el.dataset.v; },
  shareNow() { announce(); toast(bc ? 'Asked nearby devices for the latest bulletin.' : 'This browser cannot share with nearby devices.'); },
  closeSel() { UI.selZone = UI.selFac = null; },
  routeHere(el) { const f = V.fac.find(x => x.id === el.dataset.id), p = myPos(); setRoute({ x: p.x, y: p.y, kind: f.type, only: f.id, label: 'From your location', follow: true }); },
  broadcast() { if (!UI.bc.text.trim()) return toast('Write a message first.'); if (emit('alert.broadcast', { id: 'A-' + uid(), level: +UI.bc.level, title: 'Notice from control room', body: UI.bc.text.trim() })) { UI.bc.text = ''; toast(online() ? 'Broadcast sent to all devices.' : 'Broadcast saved; it goes out when you are online.'); } },
  /* volunteer task flow */
  dutyToggle() { const r = meR(); emit('vol.update', { id: r.id, onDuty: !r.onDuty }); },
  accept(el) { if (emit('task.respond', { id: el.dataset.id, accept: true })) toast(online() ? 'Task accepted. Thank you.' : 'Accepted on this device. We will confirm it when you reconnect.'); },
  decline(el) { emit('task.respond', { id: el.dataset.id, accept: false }); },
  progress(el) { if (emit('task.progress', { id: el.dataset.id, status: el.dataset.v, note: UI.pnote })) UI.pnote = ''; },
  taskRoute(el) { const t = V.tasks.find(x => x.id === el.dataset.id), p = myPos(); setRoute({ x: p.x, y: p.y, to: { x: t.x, y: t.y }, toLabel: t.title, label: 'Task route', follow: true }); },
  /* admin dispatch */
  assign(el) { const id = el.dataset.id, rid = UI.assignSel[id] || el.dataset.def; if (emit('task.assign', { id, responderId: rid })) toast('Offer sent to ' + rname(rid) + '.'); },
  redispatch(el) { emit('task.assign', { id: el.dataset.id }); },
  cancelTask(el) { emit('task.cancel', { id: el.dataset.id }); },
  autoDispatch() { emit('settings.update', { autoDispatch: !V.settings.autoDispatch }); },
  createToggle() { UI.creating = !UI.creating; },
  taskCreate() {
    const t = UI.tdraft;
    if (!t.title.trim()) return toast('Give the task a title.');
    if (t.x == null) return toast('Pick a location on the map.');
    if (emit('task.create', { id: 'T-' + uid(), title: t.title.trim(), skill: t.skill, priority: +t.priority, x: t.x, y: t.y })) { t.title = ''; t.x = t.y = null; UI.creating = false; }
  },
  async surge() { try { await api('/api/admin/demo', { action: 'surge', zoneId: UI.surgeZone }); toast('Surge started at ' + V.zones.find(z => z.id === UI.surgeZone).name + '.'); } catch (e) { toast(online() ? e.message : 'The server cannot be reached while offline.'); } },
  async calm() { try { await api('/api/admin/demo', { action: 'calm' }); toast('Zones returning to normal.'); } catch (e) { toast(e.message); } },
  ff() { ff += 5 * 60000; toast('Fast-forwarded 5 minutes (display only). Check how old each update looks.'); },
  async reset() { try { await api('/api/admin/reset', {}); OUT = []; LOG = []; LS.set(K('out'), OUT); LS.set(K('log'), LOG); UI.route = null; toast('Server data reset.'); await loadState(); } catch (e) { toast(e.message); } },
  pack() {
    if (!online()) return toast('Connect to refresh the offline pack.');
    if (UI.pack !== null) return;
    UI.pack = 0; const h = setInterval(() => { UI.pack += 10; if (UI.pack >= 100) { clearInterval(h); UI.pack = null; LS.set('cdert-pack', { ver: '2.4', ts: Date.now() }); toast('Offline pack updated.'); } renderPanel(); }, 160);
  }
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act]; if (!fn) return;
  Promise.resolve(fn(el)).finally(() => renderAll());
  renderAll();
});
document.addEventListener('input', e => {
  const el = e.target.closest('[data-bind]'); if (!el) return;
  const parts = el.dataset.bind.split('.'); let o = UI;
  while (parts.length > 1) o = o[parts.shift()];
  o[parts[0]] = el.type === 'range' ? +el.value : el.value;
  if (el.dataset.bind === 'zoneDraft') { const out = $('#zdOut'); if (out) out.textContent = (+el.value).toFixed(1) + ' people/m² · ' + LEVELS[lvlRaw(+el.value)]; }
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.id === 'userSel') { if (el.value === 'anon') signOut(); else if (el.value) signIn(el.value); el.value = ''; return; }
  if (el.dataset.assign) UI.assignSel[el.dataset.assign] = el.value;
  if (el.dataset.ttl) emit('settings.update', { offerTtl: +el.value });
});
$('#map').addEventListener('click', e => {
  const svg = $('#map');
  if (UI.pick) {
    const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    const q = p.matrixTransform(svg.getScreenCTM().inverse());
    const x = Math.max(10, Math.min(890, Math.round(q.x))), y = Math.max(10, Math.min(480, Math.round(q.y)));
    const mode = UI.pick; UI.pick = null;
    if (mode === 'loc') {
      if (isResp()) emit('vol.update', { id: ME.id, x, y }); else { MYLOC = { x, y }; LS.set('cdert-myloc', MYLOC); }
      toast('Location set to ' + zoneAt(x, y).name + '.');
    } else if (mode === 'inc') { UI.inc.x = x; UI.inc.y = y; UI.reporting = true; UI.tab = 'incidents'; toast('Incident location set.'); }
    else if (mode === 'tloc') { UI.tdraft.x = x; UI.tdraft.y = y; UI.creating = true; UI.tab = 'tasks'; toast('Task location set.'); }
    renderAll(); return;
  }
  const z = e.target.closest('[data-zone]'), f = e.target.closest('[data-fac]');
  if (f) { UI.selFac = f.dataset.fac; UI.selZone = null; }
  else if (z) { UI.selZone = z.dataset.zone; UI.selFac = null; const zz = V.zones.find(a => a.id === UI.selZone); UI.zoneDraft = +zz.d.toFixed(1); }
  else UI.selZone = UI.selFac = null;
  renderAll();
});
window.addEventListener('offline', () => { netFail = true; renderHeader(); });
window.addEventListener('online', () => heartbeat());

/* ------------------------------------------------------------ rendering */
const chip = (c, t) => `<span class="chip ${c}">${t}</span>`;
const lvlChip = l => chip('r' + l, LEVELS[l]);
const freshChip = ts => { const [c, t] = fresh(ts); return chip(c, t + ' · ' + ago(ts)); };
const pendChip = p => (p ? chip('pend', '⏳ Pending sync') : '');
const lock = t => `<div class="lock">🔒 ${t}</div>`;
const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const respChip = s => ({ available: chip('avail', 'Available'), offered: chip('resp', 'Offer pending'), busy: chip('busy', 'On a task'), off: chip('off', 'Off duty') }[s]);
const taskChip = s => ({ unassigned: chip('r3', 'Unassigned'), offered: chip('resp', 'Offered'), accepted: chip('avail', 'Accepted'), enroute: chip('avail', 'En route'), onscene: chip('avail', 'On scene'), done: chip('done', 'Done'), cancelled: chip('off', 'Cancelled') }[s]);

function renderHeader() {
  $('#roleBar').innerHTML = Object.keys(ROLES).map(k => `<button data-act="role" data-v="${k}" aria-pressed="${ME.role === k}">${ROLES[k].label}</button>`).join('');
  const sel = $('#userSel');
  sel.innerHTML = `<option value="">Switch user…</option><option value="anon">Visitor (no sign-in)</option>` + USERS.map(u => `<option value="${esc(u.id)}">${esc(u.name)} · ${ROLES[u.role].label}</option>`).join('');
  $('#roleDesc').textContent = (ME.role === 'visitor' ? 'Browsing as a visitor. ' : `Signed in as ${ME.name}. `) + ROLES[ME.role].desc;
  const n = $('#net'); const on = online();
  n.className = 'net' + (on ? '' : ' off');
  n.innerHTML = `<span class="dot"></span><span><b>${on ? 'Online' : 'Offline'}</b> · ${on ? (es ? 'live' : transport === 'poll' ? 'refreshing' : 'connecting') : 'cached data'}${OUT.length ? ` · ${OUT.length} queued` : ''}</span><button class="switch" data-act="net" role="switch" aria-checked="${on}" aria-label="Simulate losing the network"></button>`;
  const b = $('#banner');
  if (UI.syncing) { b.className = 'banner sync show'; b.textContent = 'Syncing saved updates with the control room…'; }
  else if (!on) { b.className = 'banner off show'; b.textContent = `Offline. You are seeing data from ${lastSync ? clock(lastSync) : 'your last visit'}. ${OUT.length ? OUT.length + ' update' + (OUT.length > 1 ? 's are' : ' is') + ' stored on this device and will send automatically.' : 'New updates will be stored on this device and sent automatically.'}`; }
  else b.className = 'banner';
  if (!on && PEER && Date.now() - PEER.ts < 120000) b.textContent += ` Latest crowd levels came from a nearby device ${ago(PEER.ts)}.`;
}
function renderTools() {
  const L = UI.layers;
  const layers = [['density', 'Crowd density'], ['fac', 'Facilities'], ['desig', 'Designated routes'], ['paths', 'Paths'], ['inc', 'Incidents']];
  if (ME.role !== 'visitor') layers.push(['team', 'Responders']);
  $('#maptools').innerHTML = layers.map(([k, t]) => `<button class="tog" data-act="layer" data-v="${k}" aria-pressed="${L[k]}">${t}</button>`).join('') + '<span class="sp">Tap a zone or facility for details</span>';
  $('#legend').innerHTML = '<span><i class="lg0"></i>Safe under 2</span><span><i class="lg1"></i>Watch 2–3.5</span><span><i class="lg2"></i>High 3.5–5</span><span><i class="lg3"></i>Critical over 5</span><span>people per m²</span><span><i style="background:var(--sky);border-color:var(--sky-line)"></i>One-way route</span><span><i style="background:var(--accent-soft);border-color:var(--accent)"></i>Ambulance corridor</span><span>⛔ Closed</span>';
  const pb = $('#pickbar');
  pb.className = 'pickbar' + (UI.pick ? ' show' : '');
  pb.innerHTML = UI.pick ? `📍 ${{ loc: 'Tap the map to set where you are', inc: 'Tap the map to place the incident', tloc: 'Tap the map to place the task' }[UI.pick]}<button data-act="cancelPick">Cancel</button>` : '';
  $('#map').classList.toggle('picking', !!UI.pick);
}
function dotsFor(z) { let s = z.id.charCodeAt(1) * 97; const r = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; return Array.from({ length: 26 }, () => [r(), r()]); }
const DOTS = {};
function renderMap() {
  if (!V) { $('#map').innerHTML = '<rect width="900" height="560" fill="var(--land)"/><text x="450" y="270" text-anchor="middle" class="mapnote" fill="var(--muted)">No map data yet. Connect once to download it.</text>'; return; }
  const L = UI.layers, N = E.nodes(V); let h = '';
  h += '<defs><pattern id="hatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="9" stroke="var(--rose-ink)" stroke-opacity=".28" stroke-width="3.5"/></pattern></defs>';
  h += '<rect width="900" height="560" fill="var(--land)"/>';
  h += '<path d="M0 505 C150 485 300 525 450 505 S750 485 900 508 L900 560 L0 560Z" fill="var(--sky)" stroke="var(--sky-line)" stroke-width="2"/>';
  h += '<text x="450" y="542" text-anchor="middle" class="mapnote" fill="var(--sky-ink)">Triveni Sangam · river</text>';
  V.zones.forEach(z => {
    const dots = DOTS[z.id] || (DOTS[z.id] = dotsFor(z));
    const sel = UI.selZone === z.id, lv = L.density ? z.level : null;
    h += `<g class="zone" data-zone="${z.id}"><title>${esc(z.name)}: ${z.d.toFixed(1)} people/m² (${LEVELS[z.level]})</title>`;
    h += `<rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="20" class="zr ${lv === null ? 'r0' : 'r' + lv}${sel ? ' sel' : ''}" ${lv === null ? 'style="fill:var(--surface2);stroke:var(--line)"' : ''}/>`;
    if (lv === 3) h += `<rect x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="20" fill="url(#hatch)" pointer-events="none"/>`;
    h += `<text x="${z.x + 14}" y="${z.y + 24}" class="zt">${esc(z.name)}</text><text x="${z.x + 14}" y="${z.y + 42}" class="zs">${L.density ? z.d.toFixed(1) + ' /m² · ' + LEVELS[z.level] : 'Density layer hidden'}</text>`;
    if (L.density) { const k = Math.round(Math.min(1, z.d / 6) * dots.length); for (let i = 0; i < k; i++) { const [fx, fy] = dots[i]; h += `<circle cx="${(z.x + 14 + fx * (z.w - 28)).toFixed(1)}" cy="${(z.y + 54 + fy * (z.h - 66)).toFixed(1)}" r="2.6" fill="var(--ink)" opacity=".32" pointer-events="none"/>`; } }
    if (V.gates && V.gates[z.id] && V.gates[z.id].closed) h += `<rect x="${z.x + z.w - 104}" y="${z.y + 8}" width="94" height="22" rx="11" fill="var(--rose)" stroke="var(--rose-line)"/><text x="${z.x + z.w - 57}" y="${z.y + 19.5}" class="rtag" style="fill:var(--rose-ink)">⛔ Entry closed</text>`;
    h += '</g>';
  });
  if (L.paths) V.edges.forEach(([a, b]) => { if (!N[a] || !N[b]) return; h += `<line x1="${N[a].x}" y1="${N[a].y}" x2="${N[b].x}" y2="${N[b].y}" stroke="var(--surface)" stroke-width="8" stroke-linecap="round" opacity=".8" pointer-events="none"/><line x1="${N[a].x}" y1="${N[a].y}" x2="${N[b].x}" y2="${N[b].y}" stroke="var(--accent)" stroke-opacity=".4" stroke-width="2" stroke-dasharray="2 7" stroke-linecap="round" pointer-events="none"/>`; });
  if (L.desig) (V.routes || []).forEach(r => {
    const pts = r.path.map(id => N[id]).filter(Boolean); if (pts.length < 2) return;
    const col = r.status === 'closed' ? '--rose-line' : r.kind === 'service' ? '--accent' : '--sky-line';
    h += `<polyline points="${pts.map(q => q.x + ',' + q.y).join(' ')}" fill="none" stroke="var(${col})" stroke-width="${r.kind === 'service' ? 4 : 6}" stroke-opacity=".8" stroke-linecap="round" stroke-linejoin="round" ${r.status === 'closed' ? 'stroke-dasharray="3 9"' : r.kind === 'service' ? 'stroke-dasharray="10 6"' : ''} pointer-events="none"><title>${esc(r.name)} · ${r.status}</title></polyline>`;
    if (r.dir === 'one-way' && r.status !== 'closed') for (let i = 0; i < pts.length - 1; i++) { const a = pts[i], b = pts[i + 1], ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI; h += `<path d="M-6 -5 L5 0 L-6 5 Z" transform="translate(${(a.x + b.x) / 2} ${(a.y + b.y) / 2}) rotate(${ang})" fill="var(--sky-ink)" opacity=".7" pointer-events="none"/>`; }
    if (r.status === 'closed') { const m = pts[Math.floor(pts.length / 2)]; h += `<text x="${m.x}" y="${m.y}" class="ficon" style="font-size:18px" pointer-events="none">⛔</text>`; }
  });
  Object.entries(V.evac || {}).forEach(([zid, e]) => {
    const z = V.zones.find(k => k.id === zid); if (!z) return;
    e.assign.forEach(a => {
      const r = E.computeRoute(V, { x: z.x + z.w / 2, y: z.y + z.h / 2, kind: 'shelter', only: a.id }); if (!r) return;
      const end = r.pts[r.pts.length - 1];
      h += `<polyline points="${r.pts.map(q => q.x + ',' + q.y).join(' ')}" fill="none" stroke="var(--rose-line)" stroke-width="5" stroke-dasharray="10 7" stroke-linecap="round" stroke-linejoin="round" pointer-events="none"/><g pointer-events="none"><rect x="${end.x - 38}" y="${end.y - 44}" width="76" height="18" rx="9" fill="var(--rose)" stroke="var(--rose-line)"/><text x="${end.x}" y="${end.y - 35}" class="rtag" style="fill:var(--rose-ink);font-size:10px">${a.people.toLocaleString()} people</text></g>`;
    });
  });
  if (UI.route) { const pts = UI.route.pts.map(p => p.x + ',' + p.y).join(' '); h += `<polyline class="routebg" points="${pts}" pointer-events="none"/><polyline class="route" points="${pts}" pointer-events="none"/>`; }
  if (L.fac) V.fac.forEach(f => {
    const full = (f.type === 'medical' && f.free === 0) || (f.type === 'shelter' && f.occ >= f.cap) || (f.type === 'water' && f.status === 'out'), sel = UI.selFac === f.id;
    h += `<g class="fac" data-fac="${f.id}"><title>${esc(f.name)}</title><circle cx="${f.x}" cy="${f.y}" r="${sel ? 19 : 16}" fill="var(--surface)" stroke="var(${full ? '--rose-line' : FCOL[f.type]})" stroke-width="${sel ? 5 : 3.5}"/><text x="${f.x}" y="${f.y + 1}" class="ficon">${ICON[f.type]}</text><text x="${f.x}" y="${f.y + 30}" class="fl">${esc(f.name)}</text></g>`;
  });
  if (ME.role !== 'visitor' && L.team) V.tasks.filter(t => E.ACTIVE.includes(t.status) && t.assignee).forEach(t => {
    const r = V.responders.find(k => k.id === t.assignee); if (!r) return;
    h += `<line x1="${r.x}" y1="${r.y}" x2="${t.x}" y2="${t.y}" stroke="var(--accent)" stroke-width="3" stroke-dasharray="6 6" opacity=".8" pointer-events="none"/>`;
  });
  if (L.inc) V.inc.filter(i => i.status !== 'Resolved').forEach(i => {
    const c = ['', '--butter-line', '--peach-line', '--rose-line'][i.sev];
    if (i.sev >= 2) h += `<circle cx="${i.x}" cy="${i.y}" r="${i.sev * 20 + 14}" fill="none" stroke="var(${c})" stroke-width="2" stroke-dasharray="5 5" pointer-events="none"/>`;
    h += `<circle class="pulse" cx="${i.x}" cy="${i.y}" r="12" fill="var(${c})" pointer-events="none"/><g><title>${esc(i.type)} · ${esc(i.status)}</title><circle cx="${i.x}" cy="${i.y}" r="12" fill="var(--surface)" stroke="var(${c})" stroke-width="4"/><text x="${i.x}" y="${i.y + 1}" class="ficon" style="font-size:13px">${INC[i.type].ic}</text></g>`;
  });
  if (ME.role !== 'visitor' && L.team) V.tasks.filter(t => !t.incidentId && !['done', 'cancelled'].includes(t.status)).forEach(t => { h += `<g><title>${esc(t.title)}</title><circle cx="${t.x}" cy="${t.y}" r="11" fill="var(--surface)" stroke="var(--accent)" stroke-width="3"/><text x="${t.x}" y="${t.y + 1}" class="ficon" style="font-size:12px">📋</text></g>`; });
  if (ME.role !== 'visitor' && L.team) V.responders.forEach(r => {
    const s = E.responderStatus(V, r), col = { available: '--mint-line', offered: '--sky-line', busy: '--peach-line', off: '--line' }[s], mine = r.id === ME.id;
    const ini = r.name.replace(/^(Dr\.|Nurse)\s/, '').split(' ').map(w => w[0]).join('').slice(0, 2);
    h += `<g><title>${esc(r.name)} · ${s}</title>${mine ? `<circle class="pulse" cx="${r.x}" cy="${r.y}" r="11" fill="var(--accent)"/>` : ''}<rect x="${r.x - 12}" y="${r.y - 9}" width="24" height="18" rx="9" fill="var(${col})" stroke="var(--surface)" stroke-width="2"/><text x="${r.x}" y="${r.y + 1}" class="rtag">${esc(ini)}</text></g>`;
  });
  if (UI.flash && UI.flash.until > Date.now()) h += `<circle class="pulse" cx="${UI.flash.x}" cy="${UI.flash.y}" r="30" fill="none" stroke="var(--accent)" stroke-width="4" pointer-events="none"/>`;
  if (!isResp()) { const m = MYLOC; h += `<g pointer-events="none"><circle class="pulse" cx="${m.x}" cy="${m.y}" r="10" fill="var(--accent)"/><circle cx="${m.x}" cy="${m.y}" r="8" fill="var(--accent)" stroke="#fff" stroke-width="3"/><text x="${m.x}" y="${m.y - 16}" class="fl" style="fill:var(--accent-ink);font-size:12px">You</text></g>`; }
  $('#map').innerHTML = h;
}
function facLine(f) {
  if (f.type === 'medical') return `${f.free}/${f.beds} beds free · ${f.ambFree}/${f.amb} ambulances ready`;
  if (f.type === 'shelter') return `${f.occ}/${f.cap} places taken`;
  if (f.type === 'water') return 'Water supply: ' + (f.status === 'ok' ? 'normal' : f.status === 'low' ? 'running low' : 'out of service');
  if (f.type === 'police') return `${f.officers} officers on duty`;
  return `Desk open · ${f.waiting} families waiting`;
}
function renderStrip() {
  if (!V) { $('#strip').innerHTML = ''; return; }
  let h = ''; const r = UI.route;
  if (r) h += `<div class="s"><span class="grow"><b>${esc(r.spec.label)} → ${esc(r.targetName)}</b><br>${r.dist} m · about ${r.eta} min on foot · ${r.avoided.length ? 'avoids ' + esc(r.avoided.map(z => z.name).join(', ')) + ' (crowded)' : 'shortest route is also the safest'}${r.warn.length ? ' · passes through ' + esc(r.warn.map(z => z.name + ' (' + LEVELS[z.level] + ')').join(', ')) : ''}</span><button data-act="clearRoute">Clear route</button></div>`;
  if (UI.selFac) { const f = V.fac.find(x => x.id === UI.selFac); if (f) h += `<div class="s info"><span class="grow"><b>${ICON[f.type]} ${esc(f.name)}</b><br>${facLine(f)} · updated ${ago(f.upd)} by ${esc(f.by)}</span><button data-act="routeHere" data-id="${f.id}">Route here</button><button data-act="closeSel">Close</button></div>`; }
  else if (UI.selZone) { const z = V.zones.find(a => a.id === UI.selZone); if (z) h += `<div class="s info"><span class="grow"><b>${esc(z.name)}</b> ${lvlChip(z.level)}<br>${z.d.toFixed(1)} people/m² · about ${Math.round(z.d * z.area).toLocaleString()} people · ${freshChip(z.updated)}</span><button data-act="zoneDetails">Details</button><button data-act="closeSel">Close</button></div>`; }
  $('#strip').innerHTML = h;
}
function taskBadge() {
  if (!V || ME.role === 'visitor') return 0;
  if (ME.role === 'admin') return V.tasks.filter(t => ['unassigned', 'offered'].includes(t.status)).length;
  return V.tasks.filter(t => (t.status === 'offered' && t.offeredTo === ME.id)).length;
}
function renderTabs() {
  const open = V ? V.inc.filter(i => i.status !== 'Resolved').length : 0;
  const pend = OUT.length;
  const T = [['overview', 'Overview'], ['help', 'Get help'], ['incidents', 'Incidents', open]];
  if (ME.role !== 'visitor') T.push(['tasks', 'Tasks', taskBadge()]);
  T.push(['resources', 'Resources']);
  if (['admin', 'medical'].includes(ME.role)) T.push(['insights', 'Insights']);
  T.push(['sync', 'Sync', pend]);
  if (!T.some(t => t[0] === UI.tab)) UI.tab = 'overview';
  $('#tabs').innerHTML = T.map(([k, t, n]) => `<button role="tab" data-act="tab" data-v="${k}" aria-selected="${UI.tab === k}">${t}${n ? `<span class="badge">${n}</span>` : ''}</button>`).join('');
}

/* ------------------------------------------------------------- tab bodies */
function spark(z) {
  const h = (z.hist || []).slice(-20); if (h.length < 2) return '';
  const w = 150, hh = 30, max = Math.max(7, ...h.map(q => q[1]));
  const pts = h.map((q, i) => `${(i * w / (h.length - 1)).toFixed(1)},${(hh - 2 - q[1] / max * (hh - 4)).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${hh}" width="${w}" height="${hh}" role="img" aria-label="Recent density"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
function trendChip(z) {
  const t = E.trend(z);
  if (t.dir === 'rising') return chip('r2', '▲ Rising' + (t.etaMin != null && t.etaMin <= 10 ? ` · ${LEVELS[t.nextLevel]} in ~${Math.max(1, Math.round(t.etaMin))} min` : ''));
  return t.dir === 'falling' ? chip('r0', '▼ Easing') : chip('off', '● Steady');
}
function tabOverview() {
  const risky = V.zones.filter(z => z.level >= 2).length, open = V.inc.filter(i => i.status !== 'Resolved').length;
  const beds = V.fac.filter(f => f.type === 'medical').reduce((a, f) => a + f.free, 0);
  let h = `<div class="stats"><div class="stat ${risky ? 'peach' : 'mint'}"><b>${risky}</b><span>zones at high risk</span></div><div class="stat rose"><b>${open}</b><span>open incidents</span></div><div class="stat sky"><b>${beds}</b><span>free medical beds</span></div><div class="stat butter"><b>${OUT.length}</b><span>updates waiting to sync</span></div></div>`;
  Object.entries(V.evac || {}).forEach(([zid, e]) => {
    const z = V.zones.find(k => k.id === zid); if (!z) return;
    h += `<div class="item" style="background:var(--rose);border-color:var(--rose-line);color:var(--rose-ink)"><div class="hd"><b>⛔ Evacuation order: ${esc(z.name)}</b></div><div class="meta" style="color:inherit">${e.assign.map(a => `${esc(a.name)} · ${a.people.toLocaleString()} people · about ${a.eta} min`).join('<br>') || 'No shelter space is free. Use open areas and follow marshals.'}${e.unplaced ? `<br>${e.unplaced.toLocaleString()} more people need other open areas.` : ''}<br>Issued ${clock(e.ts)}</div><div class="row" style="margin-top:8px"><button class="btn" data-act="evacMe" data-id="${zid}">Route me to safety</button>${ME.role === 'admin' ? `<button class="btn" data-act="evacClear" data-id="${zid}">Lift order</button>` : ''}</div></div>`;
  });
  if (ME.role === 'admin') {
    const recs = E.recommendations(V);
    h += '<h3>Recommended actions</h3>' + (recs.map(r => `<div class="item"><div class="hd">${r.level >= 3 ? chip('r3', 'Urgent') : chip('r2', 'Advice')}<b>${esc(r.title)}</b></div><div class="meta">${esc(r.detail)}</div>${r.action ? `<div class="row" style="margin-top:8px"><button class="btn sm pri" data-act="rec" data-t="${r.action.type}" data-z="${r.action.zoneId || ''}">${esc(r.action.label)}</button></div>` : ''}</div>`).join('') || '<div class="empty">Nothing needs attention right now.</div>');
  }
  if (UI.selZone) {
    const z = V.zones.find(a => a.id === UI.selZone), d = UI.zoneDraft != null ? UI.zoneDraft : +z.d.toFixed(1), g = (V.gates || {})[z.id];
    h += `<h3>${esc(z.name)}</h3><div class="item sel"><div class="hd">${lvlChip(z.level)}${trendChip(z)}${g ? chip('r3', '⛔ Entry closed') : ''}${pendChip(z.pending)}</div><div style="margin-top:6px">${spark(z)}</div><div class="meta">${z.d.toFixed(1)} people/m² · about ${Math.round(z.d * z.area).toLocaleString()} people in ${z.area.toLocaleString()} m²<br>Source: ${esc(z.source)} · ${clock(z.updated)} · ${freshChip(z.updated)}<br>${geo(z.x + z.w / 2, z.y + z.h / 2)}${z.ground ? `<br>Last ground report: ${z.ground.d.toFixed(1)}/m² by ${esc(z.ground.by)} at ${clock(z.ground.ts)}` : ''}</div>`;
    if (can('zone.reading')) h += `<label class="f" for="zd">Report what you see on the ground</label><input id="zd" type="range" min="0" max="7" step="0.1" value="${d}" data-bind="zoneDraft"><div class="split"><span id="zdOut" style="font-weight:700">${d.toFixed(1)} people/m² · ${LEVELS[lvlRaw(d)]}</span><button class="btn pri" data-act="zoneSubmit">Share reading</button></div>`;
    else h += lock('Volunteers and administrators can submit crowd readings.');
    if (ME.role === 'admin') {
      h += `<div class="row" style="margin-top:10px"><button class="btn sm ${g ? 'mint' : 'rose'}" data-act="gate" data-id="${z.id}" data-v="${g ? 0 : 1}">${g ? 'Reopen entry' : 'Close entry'}</button></div>`;
      if (z.d > 3 && !(V.evac || {})[z.id]) {
        const pl = E.evacPlan(V, z.id);
        h += `<div class="meta" style="margin-top:10px"><b>Evacuation plan</b>: about ${pl.people.toLocaleString()} people need to leave to bring this zone back to 3 per m².<br>${pl.assign.map(a => `${esc(a.name)} · ${a.people.toLocaleString()} people · ~${a.eta} min`).join('<br>') || 'No shelter space is free.'}${pl.unplaced ? `<br>${pl.unplaced.toLocaleString()} people have no shelter space; use open ground and marshals.` : ''}</div><div class="row" style="margin-top:8px"><button class="btn sm rose" data-act="evacIssue" data-id="${z.id}">Issue evacuation order</button></div>`;
      }
    }
    h += '</div>';
  }
  h += '<h3>Live alerts</h3>' + (V.alerts.slice(0, 5).map(a => `<div class="item"><div class="hd">${a.level === 0 ? chip('r0', 'Info') : lvlChip(a.level)}<b>${esc(a.title)}</b></div><div class="meta">${esc(a.body)}<br>${clock(a.ts)} · ${ago(a.ts)} ${pendChip(a.pending)}</div></div>`).join('') || '<div class="empty">No alerts right now.</div>');
  if (can('alert.broadcast')) h += `<h3>Broadcast a notice</h3><div class="item"><div class="row"><select data-bind="bc.level" aria-label="Notice level" style="flex:0 0 130px">${[[0, 'Info'], [1, 'Watch'], [2, 'High'], [3, 'Critical']].map(([v, t]) => `<option value="${v}" ${+UI.bc.level === v ? 'selected' : ''}>${t}</option>`).join('')}</select><input type="text" data-bind="bc.text" value="${esc(UI.bc.text)}" placeholder="e.g. Gate 4 closed, use Gate 6" aria-label="Notice text" style="flex:1;min-width:150px"></div><div class="split"><span class="meta">Reaches every device. Queued if you are offline.</span><button class="btn pri" data-act="broadcast">Send notice</button></div></div>`;
  h += '<h3>Zones by density</h3>' + V.zones.slice().sort((a, b) => b.d - a.d).map(z => `<div class="item ${UI.selZone === z.id ? 'sel' : ''}"><div class="hd"><b>${esc(z.name)}</b>${lvlChip(z.level)}${trendChip(z)}<span class="meta" style="margin:0 0 0 auto">${z.d.toFixed(1)}/m²</span></div><div class="bar"><i class="r${z.level}" style="width:${Math.min(100, z.d / 7 * 100)}%"></i></div><div class="meta">${freshChip(z.updated)} ${pendChip(z.pending)}</div></div>`).join('');
  return h;
}
function tabHelp() {
  const p = myPos(), z = zoneAt(p.x, p.y), col = { medical: 'rose', shelter: 'mint', water: 'sky', police: 'butter', lost: 'peach' };
  let h = `<h3>Where you are</h3><div class="item"><div class="hd"><b>${esc(z.name)}</b>${lvlChip(z.level)}</div><div class="meta">${geo(p.x, p.y)} · GPS works without internet</div><div class="split"><span class="meta">Not right? Move your pin.</span><button class="btn sm" data-act="pick" data-v="loc">Set on map</button></div></div>`;
  h += '<h3>Find the nearest</h3><p class="sub">Routes steer around crowded zones and open incidents, using the map saved on your phone.</p><div class="quick">' + Object.keys(KINDS).map(k => `<button class="btn ${col[k]}" data-act="near" data-v="${k}"><span class="ic">${ICON[k]}</span>${KINDS[k]}</button>`).join('') + '</div>';
  const r = UI.route;
  if (r) h += `<h3>Your route</h3><div class="item sel"><div class="hd"><b>${esc(r.targetName)}</b>${chip('role', r.dist + ' m · ~' + r.eta + ' min')}</div><div class="meta">${r.avoided.length ? 'Avoids ' + esc(r.avoided.map(a => a.name + ' (' + LEVELS[a.level] + ')').join(', ')) + '.' : 'Shortest route is also the safest.'}${r.warn.length ? '<br>Heads up: passes through ' + esc(r.warn.map(a => a.name + ' (' + LEVELS[a.level] + ')').join(', ')) + '.' : ''}</div><ol class="steps">${r.via.length ? r.via.map(v => `<li>Go through ${esc(v)}</li>`).join('') : '<li>You are already here.</li>'}<li>Arrive at ${esc(r.targetName)}</li></ol></div>`;
  h += `<h3>Need urgent help?</h3><div class="item"><label class="f" for="sosT">What is happening?</label><select id="sosT" data-bind="sos.type">${['Medical help', 'Lost or separated', 'Crowd pressure', 'Fire or smoke'].map(t => `<option ${UI.sos.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select><label class="f" for="sosN">Details (optional)</label><textarea id="sosN" data-bind="sos.note" placeholder="Number of people, landmarks nearby…">${esc(UI.sos.note)}</textarea><div class="split"><span class="meta">Sends your timestamp and location.${online() ? '' : ' Saved here until you have signal.'}</span><button class="btn rose" data-act="sos">Send SOS</button></div></div>`;
  const mine = MYSOS.map(id => V.inc.find(i => i.id === id)).filter(i => i && i.status !== 'Resolved');
  if (mine.length) {
    const HELP = { finding: 'Finding the nearest responder…', assigned: 'A responder has accepted and is heading to you.', enroute: 'A responder is on the way.', onscene: 'A responder is with you.', done: 'Help has been marked complete.' };
    h += '<h3>Your SOS</h3>' + mine.map(i => { const hp = i.help || E.helpFor(V, i).help, eta = i.help ? i.eta : E.helpFor(V, i).eta; return `<div class="item sel"><div class="hd"><b>${INC[i.type].ic} ${esc(i.type)}</b>${pendChip(i.pending)}</div><div class="meta">${HELP[hp] || HELP.finding}${eta ? ` About ${eta} min away.` : ''}<br>Sent ${clock(i.ts)}${i.pending ? '. It will send as soon as you have signal.' : ''}</div></div>`; }).join('');
  }
  const GUIDE = { en: ['Stay calm and keep moving with the flow of the crowd.', 'If you feel pressure, move at an angle toward the edge and keep your arms up near your chest.', 'If you fall, protect your head and get up as quickly as you can.', 'Keep children and elders close. Agree a meeting point, for example Lost & Found.', 'Follow marshals and announcements. Do not enter closed zones.', 'In an emergency use SOS. This app works without a signal.'],
    hi: ['शांत रहें और भीड़ के साथ आगे बढ़ते रहें।', 'दबाव महसूस हो तो तिरछा चलकर किनारे की ओर जाएँ और हाथ छाती के पास रखें।', 'गिर जाएँ तो सिर को बचाएँ और जल्दी से उठें।', 'बच्चों और बुज़ुर्गों को साथ रखें। मिलने की जगह तय करें, जैसे खोया-पाया केंद्र।', 'स्वयंसेवकों और घोषणाओं का पालन करें। बंद क्षेत्रों में न जाएँ।', 'आपात स्थिति में SOS दबाएँ। यह ऐप बिना नेटवर्क के भी काम करता है।'] };
  h += `<h3>Safety guide</h3><div class="item"><div class="row"><button class="btn sm ${UI.lang === 'en' ? 'pri' : ''}" data-act="lang" data-v="en">English</button><button class="btn sm ${UI.lang === 'hi' ? 'pri' : ''}" data-act="lang" data-v="hi">हिन्दी</button></div><ul class="steps" lang="${UI.lang}">${GUIDE[UI.lang].map(t => `<li>${esc(t)}</li>`).join('')}</ul><div class="meta">Saved on your phone. Works with no signal.</div></div>`;
  return h;
}
function linkedTasks(i) { return V.tasks.filter(t => t.incidentId === i.id && !['cancelled'].includes(t.status)); }
function tabIncidents() {
  let h = `<div class="split" style="margin:0 0 8px"><h3 style="margin:0">Incident log</h3>${can('incident.create') && ME.role !== 'visitor' ? `<button class="btn pri" data-act="reportToggle">${UI.reporting ? 'Close form' : 'Report incident'}</button>` : ''}</div>`;
  if (ME.role === 'visitor') h += lock('Visitors can use SOS under Get help. Responders see full incident details.');
  if (UI.reporting && ME.role !== 'visitor') {
    const o = UI.inc, zz = o.x != null ? zoneAt(o.x, o.y) : null;
    h += `<div class="item sel"><label class="f" for="it">Type</label><select id="it" data-bind="inc.type">${Object.keys(INC).map(t => `<option value="${t}" ${o.type === t ? 'selected' : ''}>${INC[t].ic} ${t}</option>`).join('')}</select><label class="f">Severity</label><div class="seg" style="box-shadow:none;width:max-content">${[[1, 'Low'], [2, 'Medium'], [3, 'Critical']].map(([v, t]) => `<button data-act="incSev" data-v="${v}" aria-pressed="${o.sev === v}">${t}</button>`).join('')}</div><label class="f" for="in">What happened?</label><textarea id="in" data-bind="inc.note" placeholder="Short description for responders">${esc(o.note)}</textarea><div class="split"><span class="meta">📍 ${zz ? esc(zz.name) + ' · ' + geo(o.x, o.y) : 'No location yet'}</span><button class="btn sm" data-act="pick" data-v="inc">Pick on map</button></div><div class="split"><span class="meta">Time and location are stamped automatically.${ME.role !== 'admin' && E.INC[o.type].skill ? ' The nearest responder is alerted for serious cases.' : ''}</span><button class="btn pri" data-act="reportSubmit">Submit report</button></div></div>`;
  }
  const list = V.inc.slice().sort((a, b) => (a.status === 'Resolved') - (b.status === 'Resolved') || b.sev - a.sev || b.ts - a.ts);
  h += list.map(i => {
    const z = zoneAt(i.x, i.y), st = i.status === 'Open' ? 'open' : i.status === 'Responding' ? 'resp' : 'done', lt = linkedTasks(i).filter(t => t.status !== 'done');
    const active = lt.find(t => !['done', 'cancelled'].includes(t.status));
    return `<div class="item"><div class="hd"><span style="font-size:18px">${INC[i.type].ic}</span><b>${esc(i.type)}</b>${chip('r' + i.sev, ['', 'Low', 'Medium', 'Critical'][i.sev])}${chip(st, i.status)}${pendChip(i.pending)}</div><div class="meta">${i.note ? esc(i.note) + '<br>' : ''}${esc(z.name)} · ${geo(i.x, i.y)}<br>${i.by ? 'Reported by ' + esc(i.by) + ' at ' : 'Reported at '}${clock(i.ts)} · ${freshChip(i.upd)}</div>${active ? `<div class="meta" style="margin-top:6px">📋 ${taskChip(active.status)} ${active.assignee ? esc(rname(active.assignee)) : active.offeredTo ? 'offered to ' + esc(rname(active.offeredTo)) : 'waiting for a responder'}</div>` : ''}<div class="row" style="margin-top:8px"><button class="btn sm" data-act="incLocate" data-id="${i.id}">Show on map</button>${i.status !== 'Resolved' ? `<button class="btn sm sky" data-act="incEvac" data-id="${i.id}">Plan ${INC[i.type].kind === 'medical' ? 'ambulance route' : 'evacuation'}</button>` : ''}${ME.role === 'admin' && i.status !== 'Resolved' && !active ? `<button class="btn sm pri" data-act="incDispatch" data-id="${i.id}">Dispatch responder</button>` : ''}${i.status === 'Open' && can('incident.status') ? `<button class="btn sm mint" data-act="incStatus" data-id="${i.id}" data-v="Responding">Mark responding</button>` : ''}${i.status !== 'Resolved' && ['medical', 'admin'].includes(ME.role) ? `<button class="btn sm peach" data-act="incStatus" data-id="${i.id}" data-v="Resolved">Resolve</button>` : ''}</div></div>`;
  }).join('') || '<div class="empty">No incidents logged.</div>';
  return h;
}

/* ---- tasks: volunteer view */
function tlLabel(e) {
  switch (e.ev) {
    case 'created': return `Task created${e.by && e.by !== 'system' ? ' by ' + esc(e.by) : ''}`;
    case 'offered': return `Offered to <b>${esc(e.toName || e.to)}</b>${e.eta ? ` (about ${e.eta} min away)` : ''}${e.by && e.by !== 'system' ? ' by ' + esc(e.by) : ''}`;
    case 'accepted': return `Accepted by <b>${esc(e.by)}</b>${e.late ? ' · tapped offline before the offer expired, honoured on sync' : ''}`;
    case 'declined': return `Declined by ${esc(e.by)}`;
    case 'timeout': return `No answer from ${esc(rname(e.to))}; moved to next responder`;
    case 'enroute': return `${esc(e.by)} is on the way${e.note ? ': ' + esc(e.note) : ''}`;
    case 'onscene': return `${esc(e.by)} arrived on scene${e.note ? ': ' + esc(e.note) : ''}`;
    case 'done': return `Completed by ${esc(e.by)}${e.note ? ': ' + esc(e.note) : ''}`;
    case 'cancelled': return `Cancelled (${esc(e.by)})`;
    case 'no-candidate': return 'No responder available';
    case 'redispatch': return `Re-dispatched by ${esc(e.by)}`;
    default: return esc(e.ev);
  }
}
const timeline = (t, n) => `<ul class="tl">${t.timeline.slice(-n).map(e => `<li class="${e.late ? 'late' : ['timeout', 'declined', 'no-candidate', 'cancelled'].includes(e.ev) ? 'bad' : ''}">${clock(e.ts)} · ${tlLabel(e)}</li>`).join('')}</ul>`;
function etaFrom(p, t) { const r = E.computeRoute(V, { x: p.x, y: p.y, to: { x: t.x, y: t.y }, noHazard: true }); return r ? r.eta : null; }
function tabTasksResponder() {
  const r = meR(); if (!r) return '<div class="empty">Your responder profile is not available yet.</div>';
  const st = E.responderStatus(V, r), mine = V.tasks.filter(t => t.assignee === r.id), offers = V.tasks.filter(t => t.status === 'offered' && t.offeredTo === r.id);
  let h = `<h3>My duty</h3><div class="item"><div class="hd"><b>${esc(r.name)}</b>${respChip(st)}${pendChip(r.pending)}</div><div class="kv">${r.skills.map(s => chip('role', esc(E.SKILLS[s]))).join('')}</div><div class="meta" style="margin-top:6px">Location ${geo(r.x, r.y)} in ${esc(zoneAt(r.x, r.y).name)} · ${freshChip(r.locTs)}</div><div class="split"><button class="btn sm ${r.onDuty ? 'peach' : 'mint'}" data-act="dutyToggle">${r.onDuty ? 'Go off duty' : 'Go on duty'}</button><button class="btn sm" data-act="pick" data-v="loc">Update my location</button></div></div>`;
  h += `<h3>Offers for you</h3>` + (offers.map(t => `<div class="item offer"><div class="hd"><b>${esc(t.title)}</b>${chip('r' + t.priority, ['', 'Low', 'Medium', 'Critical'][t.priority])}${pendChip(t.pending)}</div><div class="meta">${esc(t.note || 'No extra details.')}<br>About ${etaFrom(r, t) || '?'} min from you · answer within <b data-expires="${t.offerExpires}">${mmss(t.offerExpires - now())}</b></div><div class="row" style="margin-top:8px"><button class="btn pri" data-act="accept" data-id="${t.id}">Accept</button><button class="btn" data-act="decline" data-id="${t.id}">Decline</button><button class="btn" data-act="taskRoute" data-id="${t.id}">Show route</button></div></div>`).join('') || `<div class="empty">${r.onDuty ? 'No offers right now. You will be alerted here.' : 'You are off duty, so no offers are sent to you.'}</div>`);
  const active = mine.filter(t => E.ACTIVE.includes(t.status));
  h += '<h3>My active task</h3>' + (active.map(t => {
    const next = { accepted: ['enroute', 'I am on my way'], enroute: ['onscene', 'I have arrived'], onscene: ['done', 'Mark task done'] }[t.status];
    return `<div class="item sel"><div class="hd"><b>${esc(t.title)}</b>${taskChip(t.status)}${pendChip(t.pending)}</div><div class="meta">${esc(t.note || '')}<br>${geo(t.x, t.y)}</div>${timeline(t, 5)}<label class="f" for="pn">Note for the control room (optional)</label><input id="pn" type="text" data-bind="pnote" value="${esc(UI.pnote)}" placeholder="e.g. Patient stable, needs stretcher"><div class="row" style="margin-top:8px"><button class="btn pri" data-act="progress" data-id="${t.id}" data-v="${next[0]}">${next[1]}</button><button class="btn" data-act="taskRoute" data-id="${t.id}">Show route</button></div></div>`;
  }).join('') || '<div class="empty">No active task. Accept an offer to start.</div>');
  const hist = mine.filter(t => t.status === 'done').slice(0, 3);
  if (hist.length) h += '<h3>Completed</h3>' + hist.map(t => `<div class="item"><div class="hd"><b>${esc(t.title)}</b>${taskChip('done')}</div><div class="meta">Finished ${ago(t.updTs)}</div></div>`).join('');
  return h;
}
/* ---- tasks: admin dispatch board */
function tabTasksAdmin() {
  const S = V.settings;
  let h = `<h3>Dispatch settings</h3><div class="item"><div class="split" style="margin-top:0"><span><b>Auto-dispatch</b><br><span class="meta">Serious incidents are offered to the nearest available responder with the right skill.</span></span><button class="btn ${S.autoDispatch ? 'mint' : ''}" data-act="autoDispatch" aria-pressed="${S.autoDispatch}">${S.autoDispatch ? 'On' : 'Off'}</button></div><div class="split"><span class="meta">If nobody answers, move to the next responder after</span><select data-ttl="1" style="width:auto" aria-label="Offer timeout">${[15, 30, 45, 60, 120].map(v => `<option value="${v}" ${S.offerTtl === v ? 'selected' : ''}>${v} s</option>`).join('')}</select></div></div>`;
  const need = V.tasks.filter(t => ['unassigned', 'offered'].includes(t.status)), act = V.tasks.filter(t => E.ACTIVE.includes(t.status)), hist = V.tasks.filter(t => ['done', 'cancelled'].includes(t.status)).slice(0, 3);
  h += `<h3>Needs attention</h3>` + (need.map(t => {
    const cands = E.candidates(V, t, { all: true }).slice(0, 5), def = (cands[0] || {}).r;
    return `<div class="item ${t.status === 'unassigned' ? '' : 'sel'}"><div class="hd"><b>${esc(t.title)}</b>${taskChip(t.status)}${chip('r' + t.priority, ['', 'Low', 'Medium', 'Critical'][t.priority])}${pendChip(t.pending)}</div><div class="meta">Needs ${esc(E.SKILLS[t.skill])} · ${esc(zoneAt(t.x, t.y).name)}${t.status === 'offered' ? `<br>Offered to <b>${esc(rname(t.offeredTo))}</b> · expires in <b data-expires="${t.offerExpires}">${mmss(t.offerExpires - now())}</b>` : ''}</div>${timeline(t, 3)}<div class="row" style="margin-top:8px">${cands.length ? `<select data-assign="${t.id}" style="flex:1;min-width:160px" aria-label="Choose responder">${cands.map(c => `<option value="${c.r.id}" ${(UI.assignSel[t.id] || def.id) === c.r.id ? 'selected' : ''}>${esc(c.r.name)} · ${c.eta} min${c.exact ? '' : ' · general'}${E.responderStatus(V, c.r) !== 'available' ? ' · ' + E.responderStatus(V, c.r) : ''}</option>`).join('')}</select><button class="btn pri sm" data-act="assign" data-id="${t.id}" data-def="${def.id}">Assign</button>` : '<span class="meta">No one on duty.</span>'}<button class="btn sm" data-act="redispatch" data-id="${t.id}">Auto</button><button class="btn sm peach" data-act="cancelTask" data-id="${t.id}">Cancel</button></div></div>`;
  }).join('') || '<div class="empty">Nothing waiting. New serious incidents are dispatched automatically.</div>');
  h += '<h3>In progress</h3>' + (act.map(t => `<div class="item"><div class="hd"><b>${esc(t.title)}</b>${taskChip(t.status)}${pendChip(t.pending)}</div><div class="meta">${esc(rname(t.assignee))} · updated ${ago(t.updTs)}</div>${timeline(t, 3)}<div class="row" style="margin-top:6px"><button class="btn sm peach" data-act="cancelTask" data-id="${t.id}">Cancel</button></div></div>`).join('') || '<div class="empty">No tasks in progress.</div>');
  h += `<div class="split" style="margin:14px 0 6px"><h3 style="margin:0">New task</h3><button class="btn sm" data-act="createToggle">${UI.creating ? 'Close' : 'Create task'}</button></div>`;
  if (UI.creating) { const d = UI.tdraft; h += `<div class="item sel"><label class="f" for="tt">What needs doing?</label><input id="tt" type="text" data-bind="tdraft.title" value="${esc(d.title)}" placeholder="e.g. Marshal needed at Gate 4"><div class="row"><div style="flex:1;min-width:140px"><label class="f" for="ts">Skill</label><select id="ts" data-bind="tdraft.skill">${Object.keys(E.SKILLS).map(s => `<option value="${s}" ${d.skill === s ? 'selected' : ''}>${esc(E.SKILLS[s])}</option>`).join('')}</select></div><div style="flex:1;min-width:120px"><label class="f" for="tp">Priority</label><select id="tp" data-bind="tdraft.priority">${[[1, 'Low'], [2, 'Medium'], [3, 'Critical']].map(([v, t]) => `<option value="${v}" ${+d.priority === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div></div><div class="split"><span class="meta">📍 ${d.x != null ? esc(zoneAt(d.x, d.y).name) + ' · ' + geo(d.x, d.y) : 'No location yet'}</span><button class="btn sm" data-act="pick" data-v="tloc">Pick on map</button></div><div class="split"><span class="meta">Goes to the best available responder.</span><button class="btn pri" data-act="taskCreate">Create and dispatch</button></div></div>`; }
  h += '<h3>Responders</h3>' + V.responders.map(r => { const s = E.responderStatus(V, r), t = V.tasks.find(k => k.assignee === r.id && E.ACTIVE.includes(k.status)); return `<div class="item"><div class="hd"><b>${esc(r.name)}</b>${respChip(s)}${chip('off', ME.role && r.role === 'medical' ? 'Medical' : 'Volunteer')}</div><div class="meta">${r.skills.map(x => esc(E.SKILLS[x])).join(', ')}<br>${esc(zoneAt(r.x, r.y).name)} · location ${freshChip(r.locTs)}${t ? `<br>On: ${esc(t.title)}` : ''}</div></div>`; }).join('');
  if (hist.length) h += '<h3>Recently closed</h3>' + hist.map(t => `<div class="item"><div class="hd"><b>${esc(t.title)}</b>${taskChip(t.status)}</div><div class="meta">${t.assignee ? esc(rname(t.assignee)) + ' · ' : ''}${ago(t.updTs)}</div></div>`).join('');
  return h;
}
function tabTasks() {
  if (ME.role === 'admin') return tabTasksAdmin();
  let h = tabTasksResponder();
  const others = V.tasks.filter(t => t.assignee !== ME.id && !['done', 'cancelled'].includes(t.status)).slice(0, 5);
  if (others.length) h += '<h3>Team tasks</h3>' + others.map(t => `<div class="item"><div class="hd"><b>${esc(t.title)}</b>${taskChip(t.status)}</div><div class="meta">${t.assignee ? esc(rname(t.assignee)) : t.offeredTo ? 'Offered to ' + esc(rname(t.offeredTo)) : 'Waiting for a responder'}</div></div>`).join('');
  return h;
}
function stepper(f, fld, val, max, dl, ok) { return `<span class="stepper"><button data-act="step" data-id="${f.id}" data-f="${fld}" data-d="${-dl}" ${ok && val > 0 ? '' : 'disabled'} aria-label="Decrease">−</button><output>${val}</output><button data-act="step" data-id="${f.id}" data-f="${fld}" data-d="${dl}" ${ok && val < max ? '' : 'disabled'} aria-label="Increase">+</button></span>`; }
function tabResources() {
  const canBeds = ['medical', 'admin'].includes(ME.role), canOther = ME.role !== 'visitor';
  let h = '<h3>Medical camps</h3>' + (!canBeds ? lock('Medical teams and administrators update beds and ambulances.') : '');
  V.fac.filter(f => f.type === 'medical').forEach(f => { const pct = f.free / f.beds * 100, c = pct < 15 ? 3 : pct < 35 ? 2 : 0; h += `<div class="item"><div class="hd"><b>${ICON.medical} ${esc(f.name)}</b>${pendChip(f.pending)}</div><div class="bar"><i class="r${c}" style="width:${pct}%"></i></div><div class="split"><span class="meta">Free beds (of ${f.beds})</span>${stepper(f, 'free', f.free, f.beds, 2, canBeds)}</div><div class="split"><span class="meta">Ambulances ready (of ${f.amb})</span>${stepper(f, 'ambFree', f.ambFree, f.amb, 1, canBeds)}</div><div class="meta">Updated ${ago(f.upd)} by ${esc(f.by)} ${freshChip(f.upd)}</div></div>`; });
  h += '<h3>Shelters</h3>' + (!canOther ? lock('Responders update shelters and water points.') : '');
  V.fac.filter(f => f.type === 'shelter').forEach(f => { const pct = f.occ / f.cap * 100, c = pct > 90 ? 3 : pct > 70 ? 2 : pct > 50 ? 1 : 0; h += `<div class="item"><div class="hd"><b>${ICON.shelter} ${esc(f.name)}</b>${pendChip(f.pending)}</div><div class="bar"><i class="r${c}" style="width:${pct}%"></i></div><div class="split"><span class="meta">Places taken (of ${f.cap})</span>${stepper(f, 'occ', f.occ, f.cap, 50, canOther)}</div><div class="meta">Updated ${ago(f.upd)} by ${esc(f.by)} ${freshChip(f.upd)}</div></div>`; });
  h += '<h3>Water points</h3>';
  V.fac.filter(f => f.type === 'water').forEach(f => { h += `<div class="item"><div class="hd"><b>${ICON.water} ${esc(f.name)}</b>${pendChip(f.pending)}</div><div class="row" style="margin-top:6px">${[['ok', 'Normal', 'mint'], ['low', 'Low', 'peach'], ['out', 'Out', 'rose']].map(([v, t, c]) => `<button class="btn sm ${f.status === v ? c : ''}" data-act="water" data-id="${f.id}" data-v="${v}" ${canOther ? '' : 'disabled'} aria-pressed="${f.status === v}">${t}</button>`).join('')}</div><div class="meta">Updated ${ago(f.upd)} by ${esc(f.by)} ${freshChip(f.upd)}</div></div>`; });
  h += '<h3>Designated routes</h3>' + (ME.role !== 'admin' ? '<p class="sub">Pilgrims follow these one-way routes. The ambulance corridor is kept clear for emergency vehicles.</p>' : '');
  (V.routes || []).forEach(r => {
    h += `<div class="item"><div class="hd"><b>${r.kind === 'service' ? '🚑' : '➡️'} ${esc(r.name)}</b>${r.status === 'closed' ? chip('r3', 'Closed') : chip('r0', 'Open')}${chip('off', r.dir === 'one-way' ? 'One-way' : 'Two-way')}</div><div class="meta">${r.path.map(id => esc((V.zones.find(z => z.id === id) || V.fac.find(f => f.id === id) || { name: id }).name)).join(' → ')}</div>${ME.role === 'admin' ? `<div class="row" style="margin-top:8px"><button class="btn sm ${r.status === 'closed' ? 'mint' : 'rose'}" data-act="routeSet" data-id="${r.id}" data-v="${r.status === 'closed' ? 'open' : 'closed'}">${r.status === 'closed' ? 'Reopen route' : 'Close route'}</button></div>` : ''}</div>`;
  });
  h += '<h3>Support desks</h3>' + V.fac.filter(f => f.type === 'police' || f.type === 'lost').map(f => `<div class="item"><div class="hd"><b>${ICON[f.type]} ${esc(f.name)}</b></div><div class="meta">${facLine(f)}</div></div>`).join('');
  return h;
}
const fmtSec = v => (v == null ? 'n/a' : v < 90 ? v + ' s' : Math.floor(v / 60) + ' min ' + String(v % 60).padStart(2, '0') + ' s');
function bars(rows, max) { return rows.map(([label, val, cls, txt]) => `<div class="split" style="margin-top:6px;flex-wrap:nowrap"><span class="meta" style="min-width:118px">${esc(label)}</span><div class="bar" style="flex:1;margin:0"><i class="${cls || 'r0'}" style="width:${Math.min(100, val / max * 100)}%"></i></div><b style="min-width:42px;text-align:right">${txt || val}</b></div>`).join(''); }
function tabInsights() {
  const I = E.insights(V), tk = ME.token ? '?token=' + encodeURIComponent(ME.token) : '';
  let h = `<h3>Response times</h3><div class="stats"><div class="stat sky"><b>${fmtSec(I.avgAcceptSec)}</b><span>average time to accept</span></div><div class="stat ${I.within5 != null && I.within5 < 80 ? 'peach' : 'mint'}"><b>${I.within5 == null ? 'n/a' : I.within5 + '%'}</b><span>on scene within 5 min</span></div><div class="stat butter"><b>${fmtSec(I.avgSceneSec)}</b><span>average time to scene</span></div><div class="stat ${I.escalations ? 'peach' : 'mint'}"><b>${I.escalations}</b><span>offers declined or timed out</span></div></div>`;
  h += `<p class="hint">${I.done} of ${I.tasks} tasks completed, ${I.active} in progress, ${I.waiting} waiting. Target: on scene within 5 minutes.</p>`;
  h += '<h3>Peak crowd density</h3><div class="item">' + bars(I.peaks.map(p => [p.name, +p.peak.toFixed(1), 'r' + E.lvlRaw(p.peak), p.peak.toFixed(1) + '/m²']), 7) + '<div class="meta" style="margin-top:6px">Highest reading in the recent history kept on the server.</div></div>';
  h += '<h3>Incidents</h3><div class="item">' + (Object.keys(I.byType).length ? bars(Object.entries(I.byType).map(([t, n]) => [t, n, 'r1']), Math.max(3, ...Object.values(I.byType))) : '<div class="meta">None logged.</div>') + `<div class="meta" style="margin-top:6px">${I.open} open of ${I.incidents} logged.</div></div>`;
  h += '<h3>Resource use</h3><div class="item">' + bars([['Medical beds in use', I.bedsUsedPct, I.bedsUsedPct > 85 ? 'r3' : I.bedsUsedPct > 65 ? 'r2' : 'r0', I.bedsUsedPct + '%'], ['Shelter places taken', I.shelterUsedPct, I.shelterUsedPct > 85 ? 'r3' : I.shelterUsedPct > 65 ? 'r2' : 'r0', I.shelterUsedPct + '%']], 100) + `<div class="meta" style="margin-top:8px">Responders: ${I.responders.available} available, ${I.responders.busy} on tasks, ${I.responders.offered} with an offer, ${I.responders.off} off duty.</div></div>`;
  if (ME.role === 'admin') h += `<h3>Export for GIS and review</h3><div class="item"><div class="meta">Open the GeoJSON in QGIS, ArcGIS or any GIS tool. Zones, facilities, incidents and routes use WGS84 coordinates.</div><div class="row" style="margin-top:8px"><a class="btn sm" href="/api/export/geojson${tk}">GeoJSON</a><a class="btn sm" href="/api/export/incidents.csv${tk}">Incidents CSV</a><a class="btn sm" href="/api/export/tasks.csv${tk}">Tasks CSV</a></div></div>`;
  return h;
}
function tabSync() {
  const pk = LS.get('cdert-pack', { ver: '2.3', ts: Date.now() - 26 * 3600000 }), on = online();
  let h = `<h3>Connection</h3><div class="item"><div class="hd"><b>${on ? 'Online' : 'Offline'}</b>${chip(on ? 'fresh' : 'r2', on ? (es ? 'Live updates' : transport === 'poll' ? 'Refreshing every few seconds' : 'Connecting') : 'Using cached data')}</div><div class="meta">Last sync ${lastSync ? clock(lastSync) + ' (' + ago(lastSync) + ')' : 'never'}. ${on ? 'Updates go out immediately.' : OUT.length + ' update' + (OUT.length === 1 ? '' : 's') + ' stored on this device.'}${simOffline ? ' You switched the network off for this demo.' : netFail ? ' The server cannot be reached.' : ''}</div><div class="split"><span class="meta">Try it: go offline, accept a task or report something, then reconnect.</span><button class="btn ${simOffline ? 'mint' : 'peach'}" data-act="net">${simOffline ? 'Reconnect' : 'Simulate no signal'}</button></div></div>`;
  h += `<h3>Offline pack on this phone</h3><div class="item"><div class="hd"><b>Version ${pk.ver}</b>${chip('fresh', 'Ready offline')}</div><div class="pack" style="margin-top:6px"><span>App, maps and routes</span><span>Cached by the service worker</span><span>Latest data</span><span>Saved on this device</span><span>Safety guide (English, Hindi)</span><span>Included</span></div>${UI.pack !== null ? `<div class="bar"><i class="r0" style="width:${UI.pack}%"></i></div>` : ''}<div class="split"><span class="meta">Downloaded ${ago(pk.ts)}</span><button class="btn sm" data-act="pack" ${UI.pack !== null ? 'disabled' : ''}>${UI.pack !== null ? 'Downloading…' : 'Refresh pack'}</button></div></div>`;
  const peerN = Object.values(peers).filter(t => Date.now() - t < 20000).length;
  h += `<h3>Nearby devices</h3><div class="item"><div class="hd"><b>Signed bulletins</b>${chip(bc ? 'fresh' : 'off', bc ? 'Available' : 'Not supported')}</div><div class="meta">When one device has signal, nearby devices with none can receive the latest crowd levels, alerts and closures from it. Each bulletin is signed by the control room, so a forged one is rejected.${PEER ? `<br>Last received from a nearby device ${ago(PEER.ts)}.` : ''}<br>Devices heard in the last 20 s: ${peerN}</div><div class="split"><span class="meta">Demo: works between tabs of this browser. A field build would use Bluetooth or Wi-Fi Direct with the same signed bulletins.</span><button class="btn sm" data-act="shareNow">Ask nearby</button></div></div>`;
  h += `<h3>Update log</h3><p class="sub">Every change keeps its time and location so responders can judge how fresh it is.</p>` + (LOG.map(q => `<div class="item"><div class="hd">${chip(q.state === 'synced' ? 'done' : q.state === 'rejected' ? 'r3' : 'pend', q.state === 'synced' ? '✓ Synced' : q.state === 'rejected' ? 'Not applied' : q.state === 'sending' ? 'Sending' : '⏳ Pending')}<b>${esc(q.kind)}</b><span class="meta" style="margin:0 0 0 auto">${clock(q.ts)}</span></div><div class="meta">${esc(q.summary)}${q.msg ? '<br>' + esc(q.msg) : ''}</div></div>`).join('') || '<div class="empty">No updates yet.</div>');
  if (ME.role === 'admin') h += `<h3>Demo controls</h3><div class="item"><label class="f" for="sz">Simulate a crowd surge at</label><div class="row"><select id="sz" data-bind="surgeZone" style="flex:1">${V.zones.map(z => `<option value="${z.id}" ${UI.surgeZone === z.id ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}</select><button class="btn rose" data-act="surge">Start surge</button></div><div class="row" style="margin-top:10px"><button class="btn sm" data-act="calm">Calm all zones</button><button class="btn sm" data-act="ff">Fast-forward 5 min</button><button class="btn sm peach" data-act="reset">Reset server data</button></div></div>`;
  else h += `<h3>Demo controls</h3><div class="item"><div class="row"><button class="btn sm" data-act="ff">Fast-forward 5 min</button></div><div class="meta" style="margin-top:6px">Crowd surges and resets are admin tools. Switch to Administrator to use them.</div></div>`;
  return h;
}
function renderPanel() {
  if (!V) { $('#body').innerHTML = '<div class="empty">No data on this device yet.<br>Connect once so the app can download the map and latest conditions. After that it works without signal.</div>'; return; }
  const T = { overview: tabOverview, help: tabHelp, incidents: tabIncidents, tasks: tabTasks, resources: tabResources, insights: tabInsights, sync: tabSync };
  $('#body').innerHTML = (T[UI.tab] || tabOverview)();
}
function renderLive() {
  renderHeader(); renderMap(); renderStrip(); renderTabs();
  const ae = document.activeElement;
  if (ae && ae.closest && ae.closest('#body') && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) return;
  const sc = $('.panel').scrollTop; renderPanel(); $('.panel').scrollTop = sc;
}
function renderAll() { renderTools(); renderLive(); }

/* ------------------------------------------------------------------ boot */
function secondTick() {
  document.querySelectorAll('[data-expires]').forEach(el => { const ms = +el.dataset.expires - now(); el.textContent = ms > 0 ? mmss(ms) : 'expired'; });
}
async function boot() {
  recompute(); renderAll();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('/sw.js').catch(() => {});
  loadUsers();
  // if the stored session token is no longer valid the first API call signs us out
  await resync();
  setInterval(heartbeat, 4000);
  setInterval(secondTick, 1000);
}
window.__cdert = { get PEER() { return PEER; }, acceptBulletin, get BUL() { return BUL; }, get V() { return V; }, get OUT() { return OUT; }, get ME() { return ME; }, ACT, emit, flush, resync, setSimOffline };
boot();
})();
