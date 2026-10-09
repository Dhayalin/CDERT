'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const { createApp } = require('../server.js');

let app, base;
const tmp = path.join(os.tmpdir(), 'cdert-test-' + process.pid + '.json');

async function call(method, url, body, token) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const login = async (id, pin) => (await call('POST', '/api/login', { userId: id, pin })).body.token;
const op = (type, p, ts) => ({ id: 'op-' + Math.random().toString(36).slice(2), type, p, ts: ts || Date.now() });
const sync = (token, ops) => call('POST', '/api/sync', { ops }, token);

test.before(async () => {
  app = createApp({ port: 0, dataFile: tmp, quiet: true, timers: false, noPersist: true });
  base = 'http://localhost:' + (await app.start());
});
test.after(async () => { await app.stop(); });

test('login rejects wrong PIN and accepts the right one', async () => {
  assert.equal((await call('POST', '/api/login', { userId: 'R1', pin: 'nope' })).status, 401);
  assert.ok(await login('R1', '1234'));
});

test('visitors get a privacy-filtered snapshot', async () => {
  const s = (await call('GET', '/api/state')).body;
  assert.equal(s.tasks.length, 0);
  assert.equal(s.responders.length, 0);
  assert.ok(s.zones.length === 7);
  assert.equal(s.inc[0].note, '');
});

test('visitor SOS creates an incident and auto-dispatches the nearest suitable responder', async () => {
  const r = await sync(null, [op('incident.create', { id: 'INC-t1', type: 'Medical emergency', sev: 3, x: 300, y: 210, note: 'collapsed', sos: true })]);
  assert.equal(r.body.results[0].ok, true);
  const admin = await login('admin', 'admin');
  const s = (await call('GET', '/api/state', null, admin)).body;
  const t = s.tasks.find(k => k.incidentId === 'INC-t1');
  assert.ok(t, 'task auto-created');
  assert.equal(t.status, 'offered');
  assert.equal(t.offeredTo, 'R5', 'Dr. Rao is the closest medical responder to Medical Camp A');
});

test('operations are idempotent', async () => {
  const o = op('incident.create', { id: 'INC-dup', type: 'Fire', sev: 1, x: 100, y: 100, sos: true });
  await sync(null, [o]);
  const r2 = await sync(null, [o]);
  assert.equal(r2.body.results[0].code, 'duplicate');
});

test('roles are enforced server-side', async () => {
  const r = await sync(null, [op('alert.broadcast', { body: 'hi' })]);
  assert.equal(r.body.results[0].ok, false);
  assert.equal(r.body.results[0].code, 'forbidden');
  const vol = await login('R1', '1234');
  const r2 = await sync(vol, [op('fac.update', { id: 'M1', field: 'free', value: 5 })]);
  assert.equal(r2.body.results[0].code, 'forbidden');
});

test('late offline accept is honoured when it happened before the offer expired', async () => {
  const admin = await login('admin', 'admin'), asha = await login('R1', '1234');
  const t0 = Date.now();
  await sync(admin, [op('task.create', { id: 'T-late', title: 'Crowd pressure at Ghat', skill: 'crowd', x: 450, y: 400, priority: 2 })]);
  let task = (await call('GET', '/api/state', null, admin)).body.tasks.find(k => k.id === 'T-late');
  assert.equal(task.status, 'offered');
  const first = task.offeredTo;
  assert.ok(first);
  // simulate the offer timing out and escalating to the next responder
  const db = app.db(); db.st.tasks.find(k => k.id === 'T-late').offerExpires = Date.now() - 1000; app.tickSweep();
  task = (await call('GET', '/api/state', null, admin)).body.tasks.find(k => k.id === 'T-late');
  assert.notEqual(task.offeredTo, first, 'escalated');
  assert.ok(task.timeline.some(e => e.ev === 'timeout'));
  // the first responder had accepted while offline BEFORE expiry; their op arrives now
  const firstTok = await login(first, '1234');
  const off = task.timeline.find(e => e.ev === 'offered' && e.to === first);
  const r = await sync(firstTok, [op('task.respond', { id: 'T-late', accept: true }, off.expires - 5000)]);
  assert.equal(r.body.results[0].ok, true, r.body.results[0].msg);
  task = (await call('GET', '/api/state', null, admin)).body.tasks.find(k => k.id === 'T-late');
  assert.equal(task.status, 'accepted');
  assert.equal(task.assignee, first);
  void asha; void t0;
});

test('an accept that happened AFTER expiry is rejected', async () => {
  const admin = await login('admin', 'admin');
  await sync(admin, [op('task.create', { id: 'T-exp', title: 'Lost child', skill: 'lost', x: 300, y: 120, priority: 1 })]);
  const task = (await call('GET', '/api/state', null, admin)).body.tasks.find(k => k.id === 'T-exp');
  const tok = await login(task.offeredTo, '1234');
  // the offer expired 10 seconds ago (sweep has not run yet); the responder's tap is stamped "now"
  const dbt = app.db().st.tasks.find(k => k.id === 'T-exp');
  dbt.offerExpires = Date.now() - 10000;
  dbt.timeline.filter(e => e.ev === 'offered').forEach(e => { e.expires = dbt.offerExpires; });
  const r = await sync(tok, [op('task.respond', { id: 'T-exp', accept: true }, Date.now())]);
  assert.equal(r.body.results[0].ok, false);
  assert.equal(r.body.results[0].code, 'expired');
});

test('task progress follows the state machine and only the assignee may update', async () => {
  const admin = await login('admin', 'admin'), imran = await login('R2', '1234'), asha = await login('R1', '1234');
  const r = await sync(imran, [op('task.progress', { id: 'T-seed1', status: 'done', note: 'handed to Camp A' })]);
  assert.equal(r.body.results[0].ok, true);
  const r2 = await sync(asha, [op('task.progress', { id: 'T-seed1', status: 'done' })]);
  assert.equal(r2.body.results[0].ok, false);
  void admin;
});

test('density ingest needs the sensor key and raises alerts', async () => {
  const bad = await fetch(base + '/api/sensors/density', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'wrong' }, body: '{}' });
  assert.equal(bad.status, 401);
  const ok = await fetch(base + '/api/sensors/density', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'demo-sensor-key' }, body: JSON.stringify({ readings: [{ zoneId: 'Z1', d: 5.8 }] }) });
  assert.equal((await ok.json()).accepted, 1);
  const s = (await call('GET', '/api/state')).body;
  assert.equal(s.zones.find(z => z.id === 'Z1').level, 3);
  assert.ok(s.alerts[0].title.includes('Sangam Ghat'));
});

test('stale facility updates lose to newer ones (last write wins by timestamp)', async () => {
  const med = await login('R5', '1234');
  const now = Date.now();
  await sync(med, [op('fac.update', { id: 'M2', field: 'free', value: 7 }, now)]);
  const r = await sync(med, [op('fac.update', { id: 'M2', field: 'free', value: 3 }, now - 60000)]);
  assert.equal(r.body.results[0].code, 'stale');
  const s = (await call('GET', '/api/state')).body;
  assert.equal(s.fac.find(f => f.id === 'M2').free, 7);
});
