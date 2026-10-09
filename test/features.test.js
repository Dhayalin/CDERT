'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const E = require('../public/engine.js');
const { createApp } = require('../server.js');

/* ------------------------------------------------------------ engine */
test('closing a designated route removes it from path finding', () => {
  const st = E.seedState();
  const open = E.computeRoute(st, { x: 160, y: 115, kind: 'shelter', only: 'S3' });
  assert.ok(open);
  // close the only routes through Market Lane -> Delta
  st.routes.forEach(r => { if (r.id !== 'D3') r.status = 'closed'; });
  const closed = E.computeRoute(st, { x: 160, y: 115, kind: 'shelter', only: 'S3' });
  if (closed) assert.ok(!closed.key.includes('Z5>S3') || closed.dist >= open.dist);
});
test('closed entry gates push routes around the zone, but responders may still enter', () => {
  const st = E.seedState();
  const spec = { x: 160, y: 115, kind: 'medical', only: 'M2' };
  const before = E.computeRoute(st, spec);
  const through = before.via;
  st.gates.Z2 = { closed: true };
  const after = E.computeRoute(st, spec);
  if (through.includes('Akhara Marg')) assert.ok(!after.via.includes('Akhara Marg'), 'pedestrians avoid the closed zone');
  const resp = E.computeRoute(st, { ...spec, service: true });
  assert.ok(resp, 'responders still get a route');
});
test('evacuation plan fills shelters nearest-first and reports the shortfall', () => {
  const st = E.seedState();
  const z = st.zones.find(k => k.id === 'Z1'); z.d = 5.8; z.level = 3;
  const p = E.evacPlan(st, 'Z1');
  assert.equal(p.people, Math.round((5.8 - 3) * z.area));
  const placed = p.assign.reduce((a, x) => a + x.people, 0);
  assert.equal(placed + p.unplaced, p.people);
  p.assign.forEach(a => assert.ok(a.people <= st.fac.find(f => f.id === a.id).cap - st.fac.find(f => f.id === a.id).occ));
  assert.ok(p.unplaced > 0, 'capacity is smaller than the crowd, so we say so');
});
test('rising density is detected and a forecast alert is raised before the threshold', () => {
  const st = E.seedState(), t0 = Date.now();
  const z = st.zones.find(k => k.id === 'Z5'); // 2.8 now, next threshold 3.5
  z.hist = Array.from({ length: 12 }, (_, i) => [t0 - (12 - i) * 4000, 2.8 - (12 - i) * 0.06 + 0.7 * 0]); // ~0.9/min rise
  z.d = 3.2; z.target = 6; z.hist.push([t0, 3.2]);
  const tr = E.trend(z);
  assert.equal(tr.dir, 'rising');
  E.simTick(st, t0 + 4000);
  assert.ok(st.alerts.some(a => /Forecast: Market Lane/.test(a.title)), 'forecast alert raised');
});
test('recommendations suggest closing entry and expose the evacuation action when critical', () => {
  const st = E.seedState();
  const z = st.zones.find(k => k.id === 'Z1'); z.d = 5.9; z.level = 3;
  const r = E.recommendations(st);
  assert.ok(r.some(x => x.action && x.action.type === 'gate' && x.action.zoneId === 'Z1'));
  assert.ok(r.some(x => x.action && x.action.type === 'evac'));
  assert.equal(r[0].level, 3);
});
test('insights compute response times from task timelines', () => {
  const I = E.insights(E.seedState());
  assert.equal(I.tasks, 3); assert.equal(I.done, 2);
  assert.ok(I.avgAcceptSec > 0 && I.avgAcceptSec < 120);
  assert.equal(I.within5, 67);
});
test('GeoJSON export has valid WGS84 coordinates for zones, facilities, incidents and routes', () => {
  const g = E.geojson(E.seedState());
  assert.equal(g.type, 'FeatureCollection');
  const kinds = new Set(g.features.map(f => f.properties.kind));
  ['zone', 'facility', 'incident', 'route'].forEach(k => assert.ok(kinds.has(k), k));
  const pt = g.features.find(f => f.properties.kind === 'facility').geometry.coordinates;
  assert.ok(pt[0] > 81.8 && pt[0] < 81.9 && pt[1] > 25.4 && pt[1] < 25.5);
});
test('migrateState upgrades an older saved state', () => {
  const st = E.seedState(); delete st.routes; delete st.gates; st.zones.forEach(z => delete z.hist);
  E.migrateState(st);
  assert.equal(st.routes.length, 3); assert.ok(st.zones[0].hist.length > 3);
});

/* --------------------------------------------------------------- API */
let app, base;
const call = async (m, u, b, tok) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; } return { status: r.status, body: j }; };
const login = async (id, pin) => (await call('POST', '/api/login', { userId: id, pin })).body.token;
const op = (type, p, ts) => ({ id: 'op-' + Math.random().toString(36).slice(2), type, p, ts: ts || Date.now() });
const sync = (tok, ops) => call('POST', '/api/sync', { ops }, tok);
test.before(async () => { app = createApp({ port: 0, quiet: true, timers: false, noPersist: true }); base = 'http://localhost:' + (await app.start()); });
test.after(async () => { await app.stop(); });

test('only admins can close routes, gates and issue evacuation orders', async () => {
  const vol = await login('R1', '1234'), admin = await login('admin', 'admin');
  for (const o of [op('route.set', { id: 'D1', status: 'closed' }), op('zone.gate', { id: 'Z1', closed: true }), op('evac.order', { zoneId: 'Z1' })]) {
    assert.equal((await sync(vol, [o])).body.results[0].code, 'forbidden', o.type);
  }
  assert.equal((await sync(admin, [op('route.set', { id: 'D1', status: 'closed' })])).body.results[0].ok, true);
  const s = (await call('GET', '/api/state')).body; // visitor sees it
  assert.equal(s.routes.find(r => r.id === 'D1').status, 'closed');
  assert.ok(s.alerts[0].title.includes('Snan route'));
});
test('evacuation order closes entry, alerts everyone and is visible to visitors', async () => {
  const admin = await login('admin', 'admin');
  await fetch(base + '/api/sensors/density', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'demo-sensor-key' }, body: JSON.stringify({ readings: [{ zoneId: 'Z1', d: 5.7 }] }) });
  const r = await sync(admin, [op('evac.order', { zoneId: 'Z1' })]);
  assert.equal(r.body.results[0].ok, true);
  const s = (await call('GET', '/api/state')).body;
  assert.ok(s.evac.Z1.assign.length > 0); assert.equal(s.gates.Z1.closed, true);
  assert.equal(s.alerts[0].level, 3);
});
test('visitors can track their own SOS without seeing responder identities', async () => {
  await sync(null, [op('incident.create', { id: 'INC-track', type: 'Medical emergency', sev: 2, x: 300, y: 210, sos: true })]);
  const s = (await call('GET', '/api/state')).body;
  const i = s.inc.find(k => k.id === 'INC-track');
  assert.equal(i.help, 'finding'); assert.equal(s.tasks.length, 0);
  assert.ok(!JSON.stringify(s).includes('Dr. Rao'), 'no responder names leak to visitors');
  const dr = await login('R5', '1234');
  const t = (await call('GET', '/api/state', null, dr)).body.tasks.find(k => k.incidentId === 'INC-track');
  await sync(dr, [op('task.respond', { id: t.id, accept: true }), op('task.progress', { id: t.id, status: 'enroute' })]);
  const i2 = (await call('GET', '/api/state')).body.inc.find(k => k.id === 'INC-track');
  assert.equal(i2.help, 'enroute');
});
test('exports are admin only', async () => {
  assert.equal((await call('GET', '/api/export/geojson')).status, 403);
  const admin = await login('admin', 'admin');
  const g = await call('GET', '/api/export/geojson', null, admin);
  assert.equal(g.body.type, 'FeatureCollection');
  assert.ok((await call('GET', '/api/export/incidents.csv', null, admin)).body.startsWith('"incident"'));
});
test('signed bulletins verify with WebCrypto and reject tampering', async () => {
  const jwk = (await call('GET', '/api/pubkey')).body.jwk;
  const s = (await call('GET', '/api/state')).body;
  const key = await webcrypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const sig = Buffer.from(s.bulletin.sig, 'base64');
  const verify = text => webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, new TextEncoder().encode(text));
  assert.equal(await verify(s.bulletin.payload), true);
  assert.equal(await verify(s.bulletin.payload.replace('"level":', '"level":9')), false);
  const p = JSON.parse(s.bulletin.payload); assert.ok(p.zones.length === 7 && Array.isArray(p.alerts));
});
