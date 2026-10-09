'use strict';
/*
 * CDERT backend for a long-running Node host (Render, Railway, Fly, a VPS, your laptop).
 * Zero npm dependencies (Node 18+). Adds Server-Sent Events and timers on top of lib/core.js.
 * For Vercel use api/[...path].js instead (same core, Redis storage, polling).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const E = require('./public/engine.js');
const core = require('./lib/core.js');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon' };

function createApp(opts = {}) {
  const PORT = opts.port ?? process.env.PORT ?? 3000;
  const DATA_FILE = opts.dataFile || process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
  const SENSOR_KEY = opts.sensorKey || process.env.SENSOR_KEY || 'demo-sensor-key';
  const DEMO = opts.demo ?? process.env.DEMO !== '0';
  const PUBLIC = path.join(__dirname, 'public');
  const log = opts.quiet ? () => {} : (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

  let db;
  try { const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); db = d && d.st && d.users ? d : core.freshDb(); } catch (e) { db = core.freshDb(); }
  core.ensure(db);
  let saveTimer = null;
  function save(now) {
    if (opts.noPersist) return;
    const write = () => {
      saveTimer = null;
      try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); db.done = db.done.slice(-3000); const tmp = DATA_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DATA_FILE); }
      catch (e) { log('save failed', e.message); }
    };
    if (now) { clearTimeout(saveTimer); write(); } else if (!saveTimer) saveTimer = setTimeout(write, 400);
  }

  const clients = new Set();
  let bcastTimer = null;
  function changed() {
    save();
    if (!bcastTimer) bcastTimer = setTimeout(() => {
      bcastTimer = null;
      clients.forEach(c => { try { c.res.write('data: ' + JSON.stringify(core.view(db, c.user)) + '\n\n'); } catch (e) { clients.delete(c); } });
    }, 120);
  }
  const run = async (write, fn) => { const out = await fn(db); if (write) changed(); return out; };
  const handle = core.makeHandler({ run, sensorKey: SENSOR_KEY, demo: DEMO, transport: 'sse', log });
  const userFromReq = (req, url) => { const h = req.headers.authorization || ''; const t = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token'); const u = t && db.sessions[t] && db.users.find(x => x.id === db.sessions[t]); return u ? { id: u.id, name: u.name, role: u.role } : { id: 'anon', name: 'Visitor', role: 'visitor' }; };

  function serveStatic(req, res, url) {
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const f = path.normalize(path.join(PUBLIC, p));
    if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/events') {
        const user = userFromReq(req, url);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 3000\n\n');
        const c = { res, user }; clients.add(c);
        res.write('data: ' + JSON.stringify(core.view(db, user)) + '\n\n');
        req.on('close', () => clients.delete(c));
        return;
      }
      if (url.pathname.startsWith('/api/')) { const r = await handle(req, res, url); if (r === false) core.send(res, 404, { error: 'Not found' }); return; }
      return serveStatic(req, res, url);
    } catch (e) {
      if (!res.headersSent) core.send(res, e.message === 'Invalid JSON' || e.message === 'Body too large' ? 400 : 500, { error: e.message });
    }
  });

  const timers = [];
  function tickSim() { E.simTick(db.st, Date.now()); E.sweep(db.st, Date.now()); db.st.v++; changed(); }
  function tickSweep() { if (E.sweep(db.st, Date.now())) { db.st.v++; changed(); } }
  function start() {
    return new Promise(resolve => {
      server.listen(PORT, () => {
        log(`CDERT running on http://localhost:${server.address().port}`);
        if (opts.timers !== false) {
          timers.push(setInterval(tickSim, 4000), setInterval(tickSweep, 1000));
          timers.push(setInterval(() => clients.forEach(c => { try { c.res.write(': ping\n\n'); } catch (e) { clients.delete(c); } }), 20000));
        }
        resolve(server.address().port);
      });
    });
  }
  function stop() {
    timers.forEach(clearInterval); clearTimeout(bcastTimer); clearTimeout(saveTimer);
    clients.forEach(c => { try { c.res.end(); } catch (e) { /* ignore */ } });
    return new Promise(r => { server.close(() => r()); if (server.closeAllConnections) server.closeAllConnections(); });
  }
  return { server, start, stop, db: () => db, tickSim, tickSweep, save };
}

module.exports = { createApp };
if (require.main === module) {
  const app = createApp();
  app.start();
  const bye = () => { app.save(true); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
