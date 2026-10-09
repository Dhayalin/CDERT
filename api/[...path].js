'use strict';
/*
 * Vercel serverless entry for CDERT. Same core as server.js (lib/core.js + public/engine.js), adapted to a
 * stateless platform:
 *   - state lives in Redis (Upstash, added from the Vercel Marketplace), not in memory or a file
 *   - there are no timers: the crowd simulation and offer-timeout sweep catch up lazily on each request
 *   - no long-lived connection: the client polls /api/state every few seconds
 * Without Redis it falls back to memory (local testing only; not durable on Vercel).
 */
const crypto = require('crypto');
const E = require('../public/engine.js');
const core = require('../lib/core.js');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const SENSOR_KEY = process.env.SENSOR_KEY || 'demo-sensor-key';
const DEMO = process.env.DEMO !== '0';
const DB_KEY = 'cdert:db', LOCK_KEY = 'cdert:lock', TICK_MS = 4000, MAX_CATCHUP = 6;

const mem = global.__cdertMem || (global.__cdertMem = new Map());
async function cmd(args) {
  if (REDIS_URL && REDIS_TOKEN) {
    const r = await fetch(REDIS_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    const j = await r.json();
    if (j.error) throw new Error('Redis: ' + j.error);
    return j.result;
  }
  const [op, key, val, ...rest] = args;
  const hit = mem.get(key), live = hit && (!hit.exp || hit.exp > Date.now());
  if (op === 'GET') return live ? hit.v : null;
  if (op === 'DEL') { mem.delete(key); return 1; }
  if (op === 'SET') {
    if (rest.includes('NX') && live) return null;
    const px = rest.indexOf('PX');
    mem.set(key, { v: val, exp: px >= 0 ? Date.now() + Number(rest[px + 1]) : 0 });
    return 'OK';
  }
  throw new Error('unsupported');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function lock() {
  const id = crypto.randomBytes(8).toString('hex');
  for (let i = 0; i < 40; i++) { if ((await cmd(['SET', LOCK_KEY, id, 'NX', 'PX', 5000])) === 'OK') return id; await sleep(75); }
  throw new Error('Busy, try again');
}
async function unlock(id) { try { if ((await cmd(['GET', LOCK_KEY])) === id) await cmd(['DEL', LOCK_KEY]); } catch (e) { /* lock expires on its own */ } }

async function open() {
  const raw = await cmd(['GET', DB_KEY]);
  const db = raw ? JSON.parse(raw) : core.freshDb();
  const had = !!(db.keys && db.st.routes);
  core.ensure(db);
  Object.defineProperty(db, '_fresh', { value: !raw || !had, enumerable: false, configurable: true });
  return db;
}
const dirty = db => { const n = Date.now(); return db._fresh || n - (db.st.lastTick || 0) >= TICK_MS || db.st.tasks.some(t => t.status === 'offered' && t.offerExpires < n); };
function advance(db) {
  const n = Date.now();
  const ticks = Math.min(MAX_CATCHUP, Math.floor((n - (db.st.lastTick || n)) / TICK_MS));
  for (let i = 0; i < ticks; i++) E.simTick(db.st, n - (ticks - 1 - i) * TICK_MS);
  if (ticks) { db.st.lastTick = n; db.st.v++; }
  if (E.sweep(db.st, n)) db.st.v++;
}
/* Takes the lock only when something must be written. */
async function run(write, fn) {
  let db = await open();
  if (!write && !dirty(db)) return fn(db);
  const id = await lock();
  try {
    db = await open();
    advance(db);
    const out = await fn(db);
    db.done = db.done.slice(-1500);
    await cmd(['SET', DB_KEY, JSON.stringify(db)]);
    return out;
  } finally { await unlock(id); }
}

const handle = core.makeHandler({ run, sensorKey: SENSOR_KEY, demo: DEMO, transport: 'poll' });
module.exports = async function handler(req, res) {
  try {
    const r = await handle(req, res, new URL(req.url, 'http://localhost'));
    if (r === false) core.send(res, 404, { error: 'Not found' });
  } catch (e) {
    core.send(res, e.message === 'Invalid JSON' || e.message === 'Body too large' ? 400 : 500, { error: e.message });
  }
};
