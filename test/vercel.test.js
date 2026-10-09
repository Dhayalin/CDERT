'use strict';
// Exercises the Vercel serverless handler (in-memory store) behind a tiny http wrapper.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const handler = require('../api/[...path].js');

let srv, base;
const call = async (m, u, b, tok) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const op = (type, p, ts) => ({ id: 'op-' + Math.random().toString(36).slice(2), type, p, ts: ts || Date.now() });
test.before(() => new Promise(r => { srv = http.createServer(handler).listen(0, () => { base = 'http://localhost:' + srv.address().port; r(); }); }));
test.after(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); }));

test('serverless: health advertises polling transport', async () => { assert.equal((await call('GET', '/api/health')).body.transport, 'poll'); });
test('serverless: login, SOS auto-dispatch and offline accept sync', async () => {
  assert.equal((await call('POST', '/api/login', { userId: 'R1', pin: 'bad' })).status, 401);
  const admin = (await call('POST', '/api/login', { userId: 'admin', pin: 'admin' })).body.token;
  const asha = (await call('POST', '/api/login', { userId: 'R1', pin: '1234' })).body.token;
  await call('POST', '/api/sync', { ops: [op('incident.create', { id: 'INC-v1', type: 'Crowd crush risk', sev: 3, x: 170, y: 330, note: 'x', sos: true })] });
  let s = (await call('GET', '/api/state', null, admin)).body;
  const t = s.tasks.find(k => k.incidentId === 'INC-v1');
  assert.equal(t.status, 'offered'); assert.equal(t.offeredTo, 'R1');
  const r = await call('POST', '/api/sync', { ops: [op('task.respond', { id: t.id, accept: true })] }, asha);
  assert.equal(r.body.results[0].ok, true);
  s = (await call('GET', '/api/state', null, admin)).body;
  assert.equal(s.tasks.find(k => k.id === t.id).assignee, 'R1');
});
test('serverless: visitors stay privacy-filtered and roles are enforced', async () => {
  const v = (await call('GET', '/api/state')).body; assert.equal(v.tasks.length, 0);
  const r = await call('POST', '/api/sync', { ops: [op('alert.broadcast', { body: 'x' })] });
  assert.equal(r.body.results[0].code, 'forbidden');
});
test('serverless: offers escalate lazily with no timers running', async () => {
  const admin = (await call('POST', '/api/login', { userId: 'admin', pin: 'admin' })).body.token;
  await call('POST', '/api/sync', { ops: [op('task.create', { id: 'T-lazy', title: 'Lost child', skill: 'lost', x: 300, y: 120, priority: 1 })] }, admin);
  let t = (await call('GET', '/api/state', null, admin)).body.tasks.find(k => k.id === 'T-lazy');
  const first = t.offeredTo; assert.ok(first);
  const mem = global.__cdertMem; const db = JSON.parse(mem.get('cdert:db').v);
  db.st.tasks.find(k => k.id === 'T-lazy').offerExpires = Date.now() - 1000; mem.get('cdert:db').v = JSON.stringify(db);
  t = (await call('GET', '/api/state', null, admin)).body.tasks.find(k => k.id === 'T-lazy');
  assert.notEqual(t.offeredTo, first);
});
test('serverless: simulation catches up on request', async () => {
  const mem = global.__cdertMem; const db = JSON.parse(mem.get('cdert:db').v);
  const before = db.st.v; db.st.lastTick = Date.now() - 20000; mem.get('cdert:db').v = JSON.stringify(db);
  const s = (await call('GET', '/api/state')).body;
  assert.ok(s.v > before);
});
test('serverless: sensor ingest requires the key', async () => {
  const bad = await fetch(base + '/api/sensors/density', { method: 'POST', headers: { 'x-api-key': 'no', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(bad.status, 401);
});

test('serverless: new features work through the Vercel handler (routes, evacuation, signed bulletin, exports)', async () => {
  const admin = (await call('POST', '/api/login', { userId: 'admin', pin: 'admin' })).body.token;
  const r = await call('POST', '/api/sync', { ops: [op('route.set', { id: 'D1', status: 'closed' }), op('zone.gate', { id: 'Z2', closed: true })] }, admin);
  assert.ok(r.body.results.every(x => x.ok));
  const s = (await call('GET', '/api/state')).body;
  assert.equal(s.routes.find(k => k.id === 'D1').status, 'closed'); assert.equal(s.gates.Z2.closed, true);
  assert.ok(s.bulletin.sig.length > 40);
  assert.ok((await call('GET', '/api/pubkey')).body.jwk.x);
  assert.equal((await call('GET', '/api/export/geojson')).status, 403);
  assert.equal((await call('GET', '/api/export/geojson', null, admin)).body.type, 'FeatureCollection');
});
