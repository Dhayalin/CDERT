'use strict';
/*
 * Transport-independent backend: routes, auth, role-filtered views, exports.
 * Used by server.js (long-running Node) and api/[...path].js (Vercel serverless).
 * The host supplies run(write, fn): it gives fn a consistent database and persists it when write is true.
 */
const crypto = require('crypto');
const E = require('../public/engine.js');
const S = require('./sign.js');

const hashPin = pin => crypto.createHash('sha256').update('cdert:' + pin).digest('hex');
function freshDb() {
  const st = E.seedState(Date.now()); st.lastTick = Date.now();
  const users = [{ id: 'admin', name: 'Control Room', role: 'admin', pinHash: hashPin('admin') }]
    .concat(st.responders.map(r => ({ id: r.id, name: r.name, role: r.role, pinHash: hashPin('1234') })));
  return { st, users, sessions: {}, done: [], fails: {}, keys: S.makeKeys() };
}
/* Bring a database saved by an older version up to date. */
function ensure(db) {
  if (!db.keys) db.keys = S.makeKeys();
  if (!db.fails) db.fails = {};
  E.migrateState(db.st);
  return db;
}

function bulletin(db) {
  const c = db._bul;
  if (c && c.v === db.st.v && Date.now() - c.at < 4000) return c.b;
  const st = db.st;
  const payload = JSON.stringify({
    v: st.v, ts: Date.now(),
    zones: st.zones.map(z => ({ id: z.id, d: +z.d.toFixed(2), level: z.level, updated: z.updated, source: z.source })),
    alerts: st.alerts.slice(0, 8), gates: st.gates || {}, routes: (st.routes || []).map(r => ({ id: r.id, status: r.status })), evac: st.evac || {}
  });
  const b = { payload, sig: S.sign(db.keys, payload) };
  Object.defineProperty(db, '_bul', { value: { v: st.v, at: Date.now(), b }, writable: true, enumerable: false, configurable: true });
  return b;
}
function view(db, user) {
  const st = db.st;
  const base = { v: st.v, serverTime: Date.now(), zones: st.zones, fac: st.fac, edges: st.edges, alerts: st.alerts.slice(0, 30), settings: st.settings, routes: st.routes || [], gates: st.gates || {}, evac: st.evac || {}, me: user, bulletin: bulletin(db) };
  if (user.role === 'visitor') {
    return { ...base, tasks: [], responders: [],
      inc: st.inc.filter(i => i.status !== 'Resolved').map(i => { const h = E.helpFor(st, i); return { id: i.id, type: i.type, sev: i.sev, x: i.x, y: i.y, status: i.status, upd: i.upd, ts: i.ts, note: '', by: '', help: h.help, eta: h.eta }; }) };
  }
  return { ...base, inc: st.inc.slice(0, 60), tasks: st.tasks.slice(0, 60), responders: st.responders };
}
function userFrom(db, req, url) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
  const uid = token && db.sessions[token];
  const u = uid && db.users.find(x => x.id === uid);
  return u ? { id: u.id, name: u.name, role: u.role } : { id: 'anon', name: 'Visitor', role: 'visitor' };
}
const send = (res, code, obj, headers) => {
  res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
  Object.entries(headers || {}).forEach(([k, v]) => res.setHeader(k, v));
  res.end(JSON.stringify(obj));
};
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { throw new Error('Invalid JSON'); } }
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 1e6) throw new Error('Body too large'); chunks.push(c); }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch (e) { throw new Error('Invalid JSON'); }
}
const csv = rows => rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
const file = (res, type, name, text) => { res.statusCode = 200; res.setHeader('Content-Type', type); res.setHeader('Content-Disposition', `attachment; filename="${name}"`); res.end(text); };

function makeHandler({ run, sensorKey, demo, transport, log }) {
  log = log || (() => {});
  /* returns false when the route is not handled here */
  return async function handle(req, res, url) {
    const route = req.method + ' ' + url.pathname.replace(/\/+$/, '');

    if (route === 'GET /api/health') return send(res, 200, { ok: true, transport, time: Date.now() });
    if (route === 'GET /api/pubkey') return run(false, async db => send(res, 200, { jwk: db.keys.pub }));
    if (route === 'GET /api/users') return run(false, async db => send(res, 200, db.users.map(u => ({ id: u.id, name: u.name, role: u.role, pinHint: demo ? (u.id === 'admin' ? 'admin' : '1234') : undefined }))));

    if (route === 'POST /api/login') {
      const b = await readBody(req);
      return run(true, async db => {
        const key = String(b.userId), f = db.fails[key] || { n: 0, t: 0 };
        if (f.n >= 8 && Date.now() - f.t < 60000) return send(res, 429, { error: 'Too many attempts. Wait a minute.' });
        const u = db.users.find(x => x.id === b.userId);
        if (!u || u.pinHash !== hashPin(String(b.pin || ''))) { db.fails[key] = { n: f.n + 1, t: Date.now() }; return send(res, 401, { error: 'Wrong user or PIN' }); }
        delete db.fails[key];
        const token = crypto.randomBytes(24).toString('hex');
        db.sessions[token] = u.id;
        const keys = Object.keys(db.sessions); if (keys.length > 300) keys.slice(0, keys.length - 300).forEach(k => delete db.sessions[k]);
        return send(res, 200, { token, user: { id: u.id, name: u.name, role: u.role } });
      });
    }
    if (route === 'POST /api/logout') {
      const h = req.headers.authorization || '';
      if (h.startsWith('Bearer ')) await run(true, async db => { delete db.sessions[h.slice(7)]; });
      return send(res, 200, { ok: true });
    }

    if (route === 'GET /api/state') return run(false, async db => send(res, 200, view(db, userFrom(db, req, url))));

    if (route === 'POST /api/sync') {
      const b = await readBody(req);
      if (!Array.isArray(b.ops) || b.ops.length > 200) return send(res, 400, { error: 'ops must be an array of at most 200 updates' });
      return run(true, async db => {
        const user = userFrom(db, req, url), now = Date.now(), results = [], seen = new Set(db.done);
        let any = false;
        for (const op of b.ops) {
          if (!op || typeof op.id !== 'string' || op.id.length > 40) { results.push({ id: op && op.id, ok: false, code: 'bad', msg: 'Malformed update' }); continue; }
          if (seen.has(op.id)) { results.push({ id: op.id, ok: true, code: 'duplicate' }); continue; }
          const r = E.applyOp(db.st, op, user, { server: true, now });
          seen.add(op.id); db.done.push(op.id);
          results.push({ id: op.id, ok: r.ok, code: r.code, msg: r.msg });
          if (r.ok && r.code !== 'duplicate') any = true;
          if (!r.ok) log('rejected', op.type, r.code, user.id);
        }
        if (any) db.st.v++;
        return send(res, 200, { results, snapshot: view(db, user) });
      });
    }

    if (route === 'POST /api/sensors/density') {
      if (req.headers['x-api-key'] !== sensorKey) return send(res, 401, { error: 'Invalid sensor key' });
      const b = await readBody(req);
      return run(true, async db => { const n = E.ingestDensity(db.st, b.readings, Date.now()); if (n) db.st.v++; return send(res, 200, { accepted: n }); });
    }

    if (url.pathname.startsWith('/api/admin/') && req.method === 'POST') {
      const b = await readBody(req);
      return run(true, async db => {
        if (userFrom(db, req, url).role !== 'admin') return send(res, 403, { error: 'Admin only' });
        const st = db.st;
        if (url.pathname === '/api/admin/demo') {
          if (b.action === 'surge') { const z = st.zones.find(k => k.id === b.zoneId); if (!z) return send(res, 400, { error: 'Unknown zone' }); z.target = 6.2; z.surgeUntil = Date.now() + 90000; z.extUntil = 0; }
          else if (b.action === 'calm') st.zones.forEach(z => { z.target = z.base; z.surgeUntil = 0; z.extUntil = 0; });
          else return send(res, 400, { error: 'Unknown action' });
          st.v++; return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/admin/reset') { const f = freshDb(); db.st = f.st; db.done = []; return send(res, 200, { ok: true }); }
        return send(res, 404, { error: 'Not found' });
      });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/export/')) {
      return run(false, async db => {
        if (userFrom(db, req, url).role !== 'admin') return send(res, 403, { error: 'Admin only' });
        const st = db.st, iso = t => new Date(t).toISOString();
        if (url.pathname === '/api/export/tasks.csv') {
          const rows = [['task', 'incident', 'title', 'skill', 'status', 'assignee', 'created', 'last_update']];
          st.tasks.forEach(t => rows.push([t.id, t.incidentId || '', t.title, t.skill, t.status, t.assignee || '', iso(t.createdTs), iso(t.updTs)]));
          return file(res, 'text/csv', 'tasks.csv', csv(rows));
        }
        if (url.pathname === '/api/export/incidents.csv') {
          const rows = [['incident', 'type', 'severity', 'status', 'zone', 'lat', 'lon', 'reported', 'last_update']];
          st.inc.forEach(i => rows.push([i.id, i.type, i.sev, i.status, E.zoneAt(st, i.x, i.y).name, (25.44 - i.y * 0.0000225).toFixed(6), (81.83 + i.x * 0.000025).toFixed(6), iso(i.ts), iso(i.upd)]));
          return file(res, 'text/csv', 'incidents.csv', csv(rows));
        }
        if (url.pathname === '/api/export/geojson') return file(res, 'application/geo+json', 'cdert.geojson', JSON.stringify(E.geojson(st)));
        return send(res, 404, { error: 'Not found' });
      });
    }
    return false;
  };
}

module.exports = { makeHandler, freshDb, ensure, view, send, hashPin };
