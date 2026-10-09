/*
 * CDERT shared engine.
 * Runs on the server (authoritative) AND in the browser (optimistic replay of the offline outbox).
 * Pure functions over a plain-JSON state object, so both sides always agree on the rules.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CDERT = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCALE = 2.5; // metres per map unit
  const LEVELS = ['Safe', 'Watch', 'High', 'Critical'];
  const THRESH = [2, 3.5, 5];
  const ADVICE = ['', 'Keep moving and follow marshals.', 'Avoid entering. Use alternate routes.', 'Entry closed. Follow evacuation directions.'];
  const INC = {
    'Medical emergency': { ic: '🚑', kind: 'medical', skill: 'medical' },
    'Crowd crush risk': { ic: '⚠️', kind: 'shelter', skill: 'crowd' },
    'Fire': { ic: '🔥', kind: 'shelter', skill: 'crowd' },
    'Missing person': { ic: '🧒', kind: 'lost', skill: 'lost' },
    'Blocked route': { ic: '🚧', kind: 'shelter', skill: 'crowd' },
    'Structural hazard': { ic: '🏚️', kind: 'shelter', skill: 'crowd' }
  };
  const KINDS = { medical: 'Medical camp', shelter: 'Shelter', water: 'Water point', police: 'Police post', lost: 'Lost & Found' };
  const SKILLS = { medical: 'First aid and medical', crowd: 'Crowd control', lost: 'Lost and found', general: 'General help' };
  const ACTIVE = ['accepted', 'enroute', 'onscene'];
  const RANK = { accepted: 1, enroute: 2, onscene: 3, done: 4 };

  const PERM = {
    'incident.create': ['visitor', 'volunteer', 'medical', 'admin'],
    'incident.status': ['volunteer', 'medical', 'admin'],
    'zone.reading': ['volunteer', 'admin'],
    'fac.update': ['volunteer', 'medical', 'admin'],
    'alert.broadcast': ['admin'],
    'task.create': ['admin'],
    'task.assign': ['admin'],
    'task.respond': ['volunteer', 'medical'],
    'task.progress': ['volunteer', 'medical', 'admin'],
    'task.cancel': ['admin'],
    'vol.update': ['volunteer', 'medical', 'admin'],
    'settings.update': ['admin'],
    'route.set': ['admin'],
    'zone.gate': ['admin'],
    'evac.order': ['admin'],
    'evac.clear': ['admin']
  };

  const uid = () => Math.random().toString(36).slice(2, 9);
  const clone = o => JSON.parse(JSON.stringify(o));
  const lvlRaw = d => (d < THRESH[0] ? 0 : d < THRESH[1] ? 1 : d < THRESH[2] ? 2 : 3);
  const geo = (x, y) => (25.44 - y * 0.0000225).toFixed(5) + ', ' + (81.83 + x * 0.000025).toFixed(5);
  const fail = (code, msg) => ({ ok: false, code, msg });
  const num = (v, lo, hi) => { v = Number(v); return Number.isFinite(v) && v >= lo && v <= hi ? v : null; };

  function lvlHyst(z) {
    const raw = lvlRaw(z.d);
    if (raw > z.level) return raw;
    if (raw < z.level && z.d < THRESH[z.level - 1] - 0.3) return z.level - 1;
    return z.level;
  }
  function zoneAt(st, x, y) {
    return st.zones.find(z => x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) ||
      st.zones.slice().sort((a, b) => Math.hypot(a.x + a.w / 2 - x, a.y + a.h / 2 - y) - Math.hypot(b.x + b.w / 2 - x, b.y + b.h / 2 - y))[0];
  }

  /* ------------------------------------------------------------------ seed */
  function seedState(t) {
    t = t || Date.now();
    const zdef = [
      ['Z1', 'Sangam Ghat', 330, 370, 240, 90, 5200, 3.1], ['Z2', 'Akhara Marg', 330, 230, 240, 120, 8000, 2.4],
      ['Z3', 'Bridge Approach', 620, 330, 200, 120, 4500, 3.6], ['Z4', 'Railway Gate', 60, 60, 200, 110, 4000, 1.9],
      ['Z5', 'Market Lane', 330, 70, 240, 130, 7000, 2.8], ['Z6', 'Pilgrim Camps', 60, 230, 220, 200, 12000, 1.2],
      ['Z7', 'Parade Ground', 620, 70, 220, 220, 15000, 0.9]
    ];
    const zones = zdef.map(([id, name, x, y, w, h, area, d], i) => ({
      id, name, x, y, w, h, area, base: d, d, target: d, level: lvlRaw(d), updated: t - (15 + i * 6) * 1000, source: 'Camera feed', surgeUntil: 0, extUntil: 0,
      hist: Array.from({ length: 12 }, (_, k) => [t - (12 - k) * 4000, +(d + Math.sin(k + i) * 0.08).toFixed(2)])
    }));
    const fac = [
      { id: 'M1', type: 'medical', name: 'Medical Camp A', x: 290, y: 205, beds: 40, free: 22, amb: 3, ambFree: 2 },
      { id: 'M2', type: 'medical', name: 'Medical Camp B', x: 595, y: 315, beds: 30, free: 9, amb: 2, ambFree: 1 },
      { id: 'M3', type: 'medical', name: 'Field Hospital', x: 298, y: 445, beds: 120, free: 64, amb: 5, ambFree: 4 },
      { id: 'S1', type: 'shelter', name: 'Shelter Alpha', x: 80, y: 462, cap: 800, occ: 210 },
      { id: 'S2', type: 'shelter', name: 'Shelter Beta', x: 860, y: 462, cap: 600, occ: 480 },
      { id: 'S3', type: 'shelter', name: 'Shelter Delta', x: 595, y: 35, cap: 1000, occ: 150 },
      { id: 'W1', type: 'water', name: 'Water Point 1', x: 305, y: 320, status: 'ok' },
      { id: 'W2', type: 'water', name: 'Water Point 2', x: 595, y: 405, status: 'low' },
      { id: 'P1', type: 'police', name: 'Police Control Post', x: 450, y: 215, officers: 12 },
      { id: 'L1', type: 'lost', name: 'Lost & Found', x: 295, y: 115, waiting: 3 }
    ].map((f, i) => ({ ...f, upd: t - (2 + i) * 60000, by: 'Control Room' }));
    const edges = [['Z4', 'Z6'], ['Z4', 'L1'], ['L1', 'Z5'], ['Z4', 'M1'], ['M1', 'Z2'], ['M1', 'Z6'], ['Z5', 'P1'], ['P1', 'Z2'], ['Z5', 'S3'], ['S3', 'Z7'], ['Z5', 'Z7'], ['Z7', 'Z3'], ['Z2', 'M2'], ['M2', 'Z3'], ['M2', 'Z7'], ['Z2', 'Z1'], ['Z6', 'M3'], ['M3', 'Z1'], ['Z6', 'S1'], ['Z6', 'W1'], ['W1', 'Z2'], ['Z1', 'W2'], ['W2', 'Z3'], ['Z3', 'S2'], ['Z1', 'Z3']];
    const responders = [
      { id: 'R1', name: 'Asha Verma', role: 'volunteer', skills: ['crowd', 'general'], x: 170, y: 330, onDuty: true },
      { id: 'R2', name: 'Imran Khan', role: 'volunteer', skills: ['medical', 'general'], x: 440, y: 300, onDuty: true },
      { id: 'R3', name: 'Meera Nair', role: 'volunteer', skills: ['lost', 'general'], x: 295, y: 130, onDuty: true },
      { id: 'R4', name: 'Karan Singh', role: 'volunteer', skills: ['crowd', 'general'], x: 730, y: 200, onDuty: false },
      { id: 'R5', name: 'Dr. Rao', role: 'medical', skills: ['medical'], x: 290, y: 225, onDuty: true },
      { id: 'R6', name: 'Nurse Fatima', role: 'medical', skills: ['medical', 'general'], x: 298, y: 430, onDuty: true }
    ].map(r => ({ ...r, locTs: t - 60000 }));
    const inc1 = { id: 'INC-seed1', type: 'Medical emergency', sev: 2, x: 440, y: 300, note: 'Elderly pilgrim with breathing difficulty.', by: 'Asha Verma', ts: t - 4 * 60000, upd: t - 90000, status: 'Responding' };
    const inc2 = { id: 'INC-seed2', type: 'Blocked route', sev: 1, x: 645, y: 385, note: 'Barricade misplaced at bridge entry lane.', by: 'Karan Singh', ts: t - 11 * 60000, upd: t - 11 * 60000, status: 'Open' };
    const tasks = [{
      id: 'T-seed1', incidentId: 'INC-seed1', title: 'Medical emergency in Akhara Marg', skill: 'medical', x: 440, y: 300, priority: 2, note: inc1.note,
      status: 'onscene', offeredTo: null, offerExpires: null, assignee: 'R2', tried: [], createdTs: t - 4 * 60000, updTs: t - 90000, etaMin: 1,
      timeline: [
        { ts: t - 4 * 60000, ev: 'created', by: 'system' },
        { ts: t - 4 * 60000 + 2000, ev: 'offered', to: 'R2', toName: 'Imran Khan', expires: t - 3 * 60000, eta: 1, by: 'system' },
        { ts: t - 3.8 * 60000, ev: 'accepted', by: 'Imran Khan' },
        { ts: t - 90000, ev: 'onscene', by: 'Imran Khan' }
      ]
    }];
    tasks.push(
      { id: 'T-seed2', incidentId: null, title: 'Missing child reported near Lost & Found', skill: 'lost', x: 295, y: 115, priority: 1, note: '', status: 'done', offeredTo: null, offerExpires: null, assignee: 'R3', tried: [], createdTs: t - 25 * 60000, updTs: t - 17 * 60000, etaMin: 1,
        timeline: [{ ts: t - 25 * 60000, ev: 'created', by: 'system' }, { ts: t - 25 * 60000 + 2000, ev: 'offered', to: 'R3', toName: 'Meera Nair', expires: t - 24 * 60000, eta: 1, by: 'system' }, { ts: t - 24.3 * 60000, ev: 'accepted', by: 'Meera Nair' }, { ts: t - 19 * 60000, ev: 'onscene', by: 'Meera Nair' }, { ts: t - 17 * 60000, ev: 'done', by: 'Meera Nair', note: 'Child reunited with family' }] },
      { id: 'T-seed3', incidentId: null, title: 'Crowd pressure at Bridge Approach', skill: 'crowd', x: 720, y: 390, priority: 2, note: '', status: 'done', offeredTo: null, offerExpires: null, assignee: 'R1', tried: [], createdTs: t - 40 * 60000, updTs: t - 30 * 60000, etaMin: 4,
        timeline: [{ ts: t - 40 * 60000, ev: 'created', by: 'system' }, { ts: t - 40 * 60000 + 2000, ev: 'offered', to: 'R1', toName: 'Asha Verma', expires: t - 39 * 60000, eta: 4, by: 'system' }, { ts: t - 40 * 60000 + 72000, ev: 'accepted', by: 'Asha Verma' }, { ts: t - 40 * 60000 + 270000, ev: 'onscene', by: 'Asha Verma' }, { ts: t - 30 * 60000, ev: 'done', by: 'Asha Verma', note: 'Queue re-formed, flow restored' }] }
    );
    const routes = [
      { id: 'D1', name: 'Snan route (in)', kind: 'pilgrim', dir: 'one-way', path: ['Z4', 'L1', 'Z5', 'P1', 'Z2', 'Z1'], status: 'open' },
      { id: 'D2', name: 'Return route (out)', kind: 'pilgrim', dir: 'one-way', path: ['Z1', 'Z3', 'Z7', 'S3', 'Z5', 'L1', 'Z4'], status: 'open' },
      { id: 'D3', name: 'Ambulance corridor', kind: 'service', dir: 'two-way', path: ['M3', 'Z6', 'M1', 'Z2', 'M2'], status: 'open' }
    ];
    const alerts = [{ id: 'A-seed1', ts: t - 6 * 60000, level: 2, title: 'Bridge Approach is crowded', body: 'Density 3.6 people/m². Avoid entering. Use alternate routes.', auto: true }];
    return { v: 1, zones, fac, edges, inc: [inc1, inc2], tasks, alerts, responders, settings: { autoDispatch: true, offerTtl: 45, demoMove: true }, routes, gates: {}, evac: {} };
  }
  /* Fills fields added in newer versions into a state saved by an older one. */
  function migrateState(st) {
    const f = seedState(Date.now());
    ['routes', 'gates', 'evac'].forEach(k => { if (st[k] === undefined) st[k] = f[k]; });
    st.zones.forEach((z, i) => { if (!z.hist) z.hist = f.zones[i].hist; });
    return st;
  }

  /* --------------------------------------------------------------- routing */
  function nodes(st) {
    const m = {};
    st.zones.forEach(z => (m[z.id] = { id: z.id, x: z.x + z.w / 2, y: z.y + z.h / 2, zone: z, type: 'zone' }));
    st.fac.forEach(f => (m[f.id] = { id: f.id, x: f.x, y: f.y, fac: f, type: f.type }));
    return m;
  }
  function adjacency(st) {
    const a = {};
    st.edges.forEach(([p, q]) => { (a[p] = a[p] || []).push(q); (a[q] = a[q] || []).push(p); });
    return a;
  }
  const riskOf = n => (n.zone ? n.zone.level : 0);
  function hazardAt(st, n) {
    let p = 0;
    st.inc.forEach(i => {
      if (i.status === 'Resolved') return;
      const d = Math.hypot(n.x - i.x, n.y - i.y);
      if (i.sev >= 2 && d < 90) p += 500; else if (i.sev === 1 && d < 60) p += 100;
    });
    return p;
  }
  function okFac(f, kind) {
    if (kind === 'medical') return f.free > 0;
    if (kind === 'shelter') return f.occ < f.cap;
    if (kind === 'water') return f.status !== 'out';
    return true;
  }
  function loadPen(f) {
    if (f.type === 'shelter') return 400 * Math.pow(f.occ / f.cap, 2);
    if (f.type === 'medical') return f.free < 4 ? 150 : 0;
    return 0;
  }
  function edgeInfo(st) {
    const key = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
    const open = {}, closed = {}, svc = {}, flow = {};
    (st.routes || []).forEach(r => {
      for (let i = 0; i < r.path.length - 1; i++) {
        const a = r.path[i], b = r.path[i + 1], k = key(a, b);
        if (r.status === 'closed') closed[k] = 1;
        else { open[k] = 1; if (r.kind === 'service') svc[k] = 1; if (r.dir === 'one-way' && r.kind === 'pilgrim') flow[a + '>' + b] = 1; }
      }
    });
    return { blocked: new Set(Object.keys(closed).filter(k => !open[k])), svc, flow, key };
  }
  /*
   * spec: {x,y,kind,only?}  -> nearest facility of a kind
   *       {x,y,to:{x,y},toLabel} -> go to a point (e.g. a responder heading to an incident)
   * Risk-weighted Dijkstra: crowded zones and open incidents cost more, so routes bend around them.
   */
  function computeRoute(st, spec) {
    const N = nodes(st), ADJ = adjacency(st), EI = edgeInfo(st);
    const ecost = (a, b, naive) => {
      const k = EI.key(a.id, b.id);
      if (EI.blocked.has(k)) return Infinity; // route closed by control room
      let d = Math.hypot(a.x - b.x, a.y - b.y) * SCALE;
      if (!spec.service) {
        if (EI.svc[k]) d *= 3; // ambulance corridor is kept clear for emergency vehicles
        if (EI.flow[b.id + '>' + a.id] && !EI.flow[a.id + '>' + b.id]) d *= 2.5; // against the designated one-way flow
      }
      const gate = !spec.service && st.gates && st.gates[b.id] && st.gates[b.id].closed ? 5000 : 0; // entry closed
      if (naive) return d + gate;
      const r = (riskOf(a) + riskOf(b)) / 2;
      return d * (1 + 1.4 * r) + gate + (spec.noHazard ? 0 : hazardAt(st, b)) + (riskOf(b) >= 3 ? 250 : 0);
    };
    const nearest = (pt) => { let s = null, b = 1e9; for (const k in N) { const d = Math.hypot(N[k].x - pt.x, N[k].y - pt.y); if (d < b) { b = d; s = k; } } return s; };
    const run = naive => {
      const cost = {}, prev = {}, done = {};
      for (const k in N) cost[k] = Infinity;
      const s = nearest(spec);
      cost[s] = 0;
      for (;;) {
        let u = null;
        for (const k in cost) if (!done[k] && (u === null || cost[k] < cost[u])) u = k;
        if (u === null || cost[u] === Infinity) break;
        done[u] = 1;
        (ADJ[u] || []).forEach(v => { if (!N[v]) return; const w = ecost(N[u], N[v], naive); if (cost[u] + w < cost[v]) { cost[v] = cost[u] + w; prev[v] = u; } });
      }
      let t = null;
      if (spec.to) { t = nearest(spec.to); if (cost[t] === Infinity) return null; }
      else {
        let bs = Infinity;
        for (const k in N) {
          const n = N[k];
          if (n.fac && n.type === spec.kind && (!spec.only || k === spec.only) && okFac(n.fac, spec.kind) && cost[k] < Infinity) {
            const sc = cost[k] + (naive ? 0 : loadPen(n.fac));
            if (sc < bs) { bs = sc; t = k; }
          }
        }
      }
      if (!t) return null;
      const path = [];
      for (let c = t; c !== undefined; c = prev[c]) path.unshift(c);
      return { path, target: t };
    };
    const safe = run(false);
    if (!safe) return null;
    const naive = run(true);
    const pts = [{ x: spec.x, y: spec.y }, ...safe.path.map(id => ({ x: N[id].x, y: N[id].y }))];
    if (spec.to) pts.push({ x: spec.to.x, y: spec.to.y });
    let dist = 0;
    for (let i = 1; i < pts.length; i++) dist += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) * SCALE;
    const zonesOn = safe.path.map(id => N[id].zone).filter(Boolean);
    const maxR = zonesOn.reduce((m, z) => Math.max(m, z.level), 0);
    const speed = Math.max(0.45, 1.1 - 0.2 * maxR);
    const avoided = naive ? naive.path.map(id => N[id].zone).filter(z => z && z.level >= 2 && !safe.path.includes(z.id)) : [];
    return {
      spec, target: safe.target, targetName: spec.to ? (spec.toLabel || 'Destination') : N[safe.target].fac.name, pts,
      dist: Math.round(dist), eta: Math.max(1, Math.round(dist / speed / 60)), via: zonesOn.map(z => z.name),
      warn: zonesOn.filter(z => z.level >= 2), avoided, key: safe.path.join('>')
    };
  }

  /* -------------------------------------------------------------- dispatch */
  function responderStatus(st, r) {
    if (!r.onDuty) return 'off';
    return st.tasks.some(t => t.assignee === r.id && ACTIVE.includes(t.status)) ? 'busy' : st.tasks.some(t => t.status === 'offered' && t.offeredTo === r.id) ? 'offered' : 'available';
  }
  /* Ranked suggestions: nearest by risk-aware walking time, preferring an exact skill match. */
  function candidates(st, t, opts) {
    opts = opts || {};
    return st.responders.filter(r => r.onDuty && (opts.all || (responderStatus(st, r) === 'available' && !t.tried.includes(r.id))))
      .map(r => {
        const exact = r.skills.includes(t.skill), gen = r.skills.includes('general');
        if (!exact && !gen && !opts.all) return null;
        const rt = computeRoute(st, { x: r.x, y: r.y, to: { x: t.x, y: t.y }, noHazard: true, service: true });
        const eta = rt ? rt.eta : 99;
        return { r, eta, exact, score: eta + (exact ? 0 : 3) };
      }).filter(Boolean).sort((a, b) => a.score - b.score);
  }
  function offerTo(st, t, r, now, eta) {
    t.status = 'offered'; t.offeredTo = r.id; t.offerExpires = now + st.settings.offerTtl * 1000; t.etaMin = eta; t.updTs = now;
    t.timeline.push({ ts: now, ev: 'offered', to: r.id, toName: r.name, expires: t.offerExpires, eta, by: 'system' });
  }
  function dispatch(st, t, now) {
    const c = candidates(st, t)[0];
    if (!c) {
      t.status = 'unassigned'; t.offeredTo = null; t.offerExpires = null; t.updTs = now;
      t.timeline.push({ ts: now, ev: 'no-candidate', by: 'system' });
      pushAlert(st, { level: 2, title: 'No responder available', body: `"${t.title}" needs ${SKILLS[t.skill] || t.skill} cover. Assign someone manually.`, auto: true }, now);
      return false;
    }
    offerTo(st, t, c.r, now, c.eta);
    return true;
  }
  /* Offers that nobody answered in time are escalated to the next-best responder. */
  function sweep(st, now) {
    let ch = false;
    st.tasks.forEach(t => {
      if (t.status === 'offered' && t.offerExpires < now) {
        t.tried.push(t.offeredTo);
        t.timeline.push({ ts: now, ev: 'timeout', to: t.offeredTo, by: 'system' });
        t.offeredTo = null;
        if (st.settings.autoDispatch) dispatch(st, t, now); else { t.status = 'unassigned'; t.updTs = now; }
        ch = true;
      }
    });
    return ch;
  }
  function newTask(st, o, ts) {
    const t = {
      id: o.id || 'T-' + uid(), incidentId: o.incidentId || null, title: String(o.title || 'Task').slice(0, 120), skill: SKILLS[o.skill] ? o.skill : 'general',
      x: o.x, y: o.y, priority: o.priority || 2, note: String(o.note || '').slice(0, 300), status: 'unassigned', offeredTo: null, offerExpires: null, assignee: null,
      tried: [], createdTs: ts, updTs: ts, etaMin: null, timeline: [{ ts, ev: 'created', by: o.by || 'system' }]
    };
    st.tasks.unshift(t);
    return t;
  }
  function pushAlert(st, a, now) {
    st.alerts.unshift({ id: a.id || 'A-' + uid(), ts: a.ts || now, level: a.level, title: a.title, body: a.body, auto: !!a.auto, zone: a.zone || null });
    st.alerts = st.alerts.slice(0, 40);
  }

  /* -------------------------------------------------------- op handlers */
  const findTask = (st, id) => st.tasks.find(t => t.id === id);
  const HANDLERS = {
    'incident.create'(st, p, c) {
      if (c.role === 'visitor' && !p.sos) return fail('forbidden', 'Visitors can only send an SOS');
      if (!INC[p.type]) return fail('bad', 'Unknown incident type');
      const x = num(p.x, 0, 900), y = num(p.y, 0, 500);
      if (x == null || y == null) return fail('bad', 'Invalid location');
      const id = String(p.id || 'INC-' + uid());
      if (st.inc.some(i => i.id === id)) return { ok: true, code: 'duplicate' };
      const i = { id, type: p.type, sev: Math.max(1, Math.min(3, parseInt(p.sev, 10) || 1)), x, y, note: String(p.note || '').slice(0, 300), by: c.role === 'visitor' ? 'Visitor SOS' : (c.user.name || c.role), ts: c.ts, upd: c.ts, status: 'Open', sos: !!p.sos };
      st.inc.unshift(i);
      const skill = INC[i.type].skill;
      if (c.opt.server && st.settings.autoDispatch && (i.sev >= 2 || skill === 'medical' || skill === 'lost')) {
        const t = newTask(st, { incidentId: i.id, title: `${i.type} in ${zoneAt(st, x, y).name}`, skill, x, y, priority: i.sev, note: i.note }, c.ts);
        dispatch(st, t, c.now);
      }
      return { ok: true, rec: i };
    },
    'incident.status'(st, p, c) {
      const i = st.inc.find(k => k.id === p.id);
      if (!i) return fail('notfound', 'Incident not found');
      if (!['Open', 'Responding', 'Resolved'].includes(p.status)) return fail('bad', 'Unknown status');
      if (p.status === 'Resolved' && !['medical', 'admin'].includes(c.role)) return fail('forbidden', 'Only medical teams or admins can resolve incidents');
      if (c.ts < i.upd) return fail('stale', 'A newer update to this incident already exists');
      i.status = p.status; i.upd = c.ts;
      if (p.status === 'Resolved') st.tasks.forEach(t => { if (t.incidentId === i.id && ['unassigned', 'offered'].includes(t.status)) { t.status = 'cancelled'; t.updTs = c.ts; t.offeredTo = null; t.timeline.push({ ts: c.ts, ev: 'cancelled', by: 'incident resolved' }); } });
      return { ok: true, rec: i };
    },
    'zone.reading'(st, p, c) {
      const z = st.zones.find(k => k.id === p.id), d = num(p.d, 0, 7);
      if (!z || d == null) return fail('bad', 'Invalid crowd reading');
      z.ground = { d, ts: c.ts, by: c.user.name || c.role };
      if (c.ts >= z.updated) {
        z.d = d; z.target = d; z.surgeUntil = c.now + 3 * 60000; z.updated = c.ts; z.source = (c.user.name || c.role) + ' (ground report)';
        pushHist(z, c.now);
        checkLevel(st, z, c.now, c.opt.server);
        return { ok: true, rec: z };
      }
      return { ok: true, code: 'recorded-older', rec: z };
    },
    'fac.update'(st, p, c) {
      const f = st.fac.find(k => k.id === p.id);
      if (!f) return fail('notfound', 'Facility not found');
      const allowed = { medical: ['free', 'ambFree'], shelter: ['occ'], water: ['status'] }[f.type] || [];
      if (!allowed.includes(p.field)) return fail('bad', 'That field cannot be changed');
      if (f.type === 'medical' && !['medical', 'admin'].includes(c.role)) return fail('forbidden', 'Only medical teams or admins can change bed and ambulance counts');
      if (c.ts < f.upd) return fail('stale', `A newer update for ${f.name} already exists`);
      if (p.field === 'status') { if (!['ok', 'low', 'out'].includes(p.value)) return fail('bad', 'Invalid status'); f.status = p.value; }
      else {
        const max = { free: f.beds, ambFree: f.amb, occ: f.cap }[p.field];
        const v = num(p.value, 0, max);
        if (v == null) return fail('bad', 'Value out of range');
        f[p.field] = Math.round(v);
      }
      f.upd = c.ts; f.by = c.user.name || c.role;
      return { ok: true, rec: f };
    },
    'alert.broadcast'(st, p, c) {
      if (!String(p.body || '').trim()) return fail('bad', 'Message is empty');
      if (p.id && st.alerts.some(a => a.id === p.id)) return { ok: true, code: 'duplicate' };
      pushAlert(st, { id: p.id, ts: c.ts, level: Math.max(0, Math.min(3, parseInt(p.level, 10) || 0)), title: String(p.title || 'Notice from control room').slice(0, 80), body: String(p.body).slice(0, 300) }, c.now);
      return { ok: true, rec: st.alerts[0] };
    },
    'task.create'(st, p, c) {
      const x = num(p.x, 0, 900), y = num(p.y, 0, 500);
      if (x == null || y == null) return fail('bad', 'Pick a location for the task');
      if (p.id && findTask(st, p.id)) return { ok: true, code: 'duplicate' };
      if (p.incidentId && !st.inc.some(i => i.id === p.incidentId)) return fail('notfound', 'Incident not found');
      const t = newTask(st, { ...p, x, y, by: c.user.name }, c.ts);
      if (c.opt.server && st.settings.autoDispatch) dispatch(st, t, c.now);
      return { ok: true, rec: t };
    },
    'task.assign'(st, p, c) {
      const t = findTask(st, p.id);
      if (!t) return fail('notfound', 'Task not found');
      if (!['unassigned', 'offered'].includes(t.status)) return fail('conflict', 'This task is already in progress');
      if (!p.responderId) {
        t.tried = []; t.timeline.push({ ts: c.ts, ev: 'redispatch', by: c.user.name });
        if (c.opt.server) dispatch(st, t, c.now);
        return { ok: true, rec: t };
      }
      const r = st.responders.find(k => k.id === p.responderId);
      if (!r) return fail('notfound', 'Responder not found');
      if (!r.onDuty) return fail('conflict', `${r.name} is off duty`);
      const rt = computeRoute(st, { x: r.x, y: r.y, to: { x: t.x, y: t.y }, noHazard: true, service: true });
      offerTo(st, t, r, c.now, rt ? rt.eta : null);
      t.timeline[t.timeline.length - 1].by = c.user.name;
      return { ok: true, rec: t };
    },
    'task.respond'(st, p, c) {
      const t = findTask(st, p.id);
      if (!t) return fail('notfound', 'Task not found');
      const me = c.user.id;
      if (p.accept) {
        if (t.assignee === me && (ACTIVE.includes(t.status) || t.status === 'done')) return { ok: true, code: 'duplicate', rec: t };
        const mine = t.timeline.filter(e => e.ev === 'offered' && e.to === me);
        const off = mine[mine.length - 1];
        if (!off) return fail('conflict', 'This task was not offered to you');
        if (c.ts > off.expires) return fail('expired', 'Your offer had already expired when you accepted');
        if (!['offered', 'unassigned'].includes(t.status)) return fail('conflict', 'Someone else already took this task');
        const late = t.offeredTo !== me;
        t.status = 'accepted'; t.assignee = me; t.offeredTo = null; t.offerExpires = null; t.updTs = c.ts;
        t.timeline.push({ ts: c.ts, ev: 'accepted', by: c.user.name, late });
        const inc = st.inc.find(i => i.id === t.incidentId);
        if (inc && inc.status === 'Open') { inc.status = 'Responding'; inc.upd = c.ts; }
        return { ok: true, code: late ? 'late-accepted' : undefined, rec: t };
      }
      if (t.offeredTo !== me) return { ok: true, code: 'duplicate', rec: t };
      t.tried.push(me); t.offeredTo = null; t.offerExpires = null; t.updTs = c.ts;
      t.timeline.push({ ts: c.ts, ev: 'declined', by: c.user.name });
      t.status = 'unassigned';
      if (c.opt.server && st.settings.autoDispatch) dispatch(st, t, c.now);
      return { ok: true, rec: t };
    },
    'task.progress'(st, p, c) {
      const t = findTask(st, p.id);
      if (!t) return fail('notfound', 'Task not found');
      if (!RANK[p.status]) return fail('bad', 'Unknown progress step');
      if (c.role !== 'admin' && t.assignee !== c.user.id) return fail('forbidden', 'Only the assigned responder can update this task');
      if (!t.assignee) return fail('conflict', 'Task has no assignee yet');
      if (RANK[p.status] <= (RANK[t.status] || 0)) return { ok: true, code: 'duplicate', rec: t };
      t.status = p.status; t.updTs = c.ts;
      t.timeline.push({ ts: c.ts, ev: p.status, by: c.user.name, note: String(p.note || '').slice(0, 200) || undefined });
      return { ok: true, rec: t };
    },
    'task.cancel'(st, p, c) {
      const t = findTask(st, p.id);
      if (!t) return fail('notfound', 'Task not found');
      if (['done', 'cancelled'].includes(t.status)) return { ok: true, code: 'duplicate', rec: t };
      t.status = 'cancelled'; t.offeredTo = null; t.offerExpires = null; t.updTs = c.ts;
      t.timeline.push({ ts: c.ts, ev: 'cancelled', by: c.user.name });
      return { ok: true, rec: t };
    },
    'vol.update'(st, p, c) {
      const id = p.id || c.user.id;
      const r = st.responders.find(k => k.id === id);
      if (!r) return fail('notfound', 'Responder not found');
      if (c.role !== 'admin' && c.user.id !== id) return fail('forbidden', 'You can only update your own status');
      if (p.x != null) {
        const x = num(p.x, 0, 900), y = num(p.y, 0, 500);
        if (x == null || y == null) return fail('bad', 'Invalid location');
        if (c.ts >= r.locTs) { r.x = x; r.y = y; r.locTs = c.ts; }
      }
      if (typeof p.onDuty === 'boolean') r.onDuty = p.onDuty;
      return { ok: true, rec: r };
    },
    'route.set'(st, p, c) {
      const r = (st.routes || []).find(k => k.id === p.id);
      if (!r) return fail('notfound', 'Route not found');
      if (!['open', 'closed'].includes(p.status)) return fail('bad', 'Status must be open or closed');
      if (r.status === p.status) return { ok: true, code: 'duplicate' };
      r.status = p.status; r.ts = c.ts;
      pushAlert(st, { level: p.status === 'closed' ? 2 : 0, title: `${r.name} ${p.status === 'closed' ? 'closed' : 'reopened'}`, body: p.status === 'closed' ? 'Do not use this route. Follow marshals and the alternate route shown on the map.' : 'The route is open again.' }, c.now);
      return { ok: true };
    },
    'zone.gate'(st, p, c) {
      const z = st.zones.find(k => k.id === p.id);
      if (!z) return fail('notfound', 'Zone not found');
      st.gates = st.gates || {};
      const was = !!(st.gates[z.id] && st.gates[z.id].closed);
      if (was === !!p.closed) return { ok: true, code: 'duplicate' };
      if (p.closed) st.gates[z.id] = { closed: true, ts: c.ts, by: c.user.name }; else delete st.gates[z.id];
      pushAlert(st, { level: p.closed ? 2 : 0, zone: z.id, title: `Entry to ${z.name} ${p.closed ? 'closed' : 'reopened'}`, body: p.closed ? 'Do not enter. Use the alternate routes shown on the map.' : 'Entry is open again.' }, c.now);
      return { ok: true, rec: z };
    },
    'evac.order'(st, p, c) {
      const z = st.zones.find(k => k.id === p.zoneId);
      if (!z) return fail('notfound', 'Zone not found');
      const plan = evacPlan(st, z.id);
      st.evac = st.evac || {}; st.gates = st.gates || {};
      st.evac[z.id] = { ts: c.ts, by: c.user.name, people: plan.people, unplaced: plan.unplaced, assign: plan.assign.map(a => ({ id: a.id, name: a.name, people: a.people, dist: a.dist, eta: a.eta })) };
      st.gates[z.id] = { closed: true, ts: c.ts, by: c.user.name };
      pushAlert(st, { level: 3, zone: z.id, title: `Evacuation order: ${z.name}`,
        body: (plan.assign.length ? plan.assign.map(a => `${a.name} (${a.people.toLocaleString('en-US')} people, about ${a.eta} min)`).join('; ') : 'No shelter space is free. Use open areas and follow marshals.') + (plan.unplaced ? `. ${plan.unplaced.toLocaleString('en-US')} more people need other open areas.` : '') }, c.now);
      return { ok: true, rec: z };
    },
    'evac.clear'(st, p, c) {
      if (!st.evac || !st.evac[p.zoneId]) return { ok: true, code: 'duplicate' };
      const z = st.zones.find(k => k.id === p.zoneId);
      delete st.evac[p.zoneId]; if (st.gates) delete st.gates[p.zoneId];
      pushAlert(st, { level: 0, zone: p.zoneId, title: `Evacuation order lifted: ${z ? z.name : p.zoneId}`, body: 'Entry is open again. Follow marshals.' }, c.now);
      return { ok: true };
    },
    'settings.update'(st, p) {
      if (typeof p.autoDispatch === 'boolean') st.settings.autoDispatch = p.autoDispatch;
      if (p.offerTtl != null) { const v = num(p.offerTtl, 10, 300); if (v == null) return fail('bad', 'Timeout must be 10–300 seconds'); st.settings.offerTtl = Math.round(v); }
      return { ok: true };
    }
  };

  /*
   * Apply one client operation. Used by the server (authoritative) and by the client
   * (opt.optimistic) to show offline changes immediately and flag them as pending.
   */
  function applyOp(st, op, user, opt) {
    opt = opt || {};
    const now = opt.now || Date.now();
    const role = (user && user.role) || 'visitor';
    if (!op || typeof op.type !== 'string' || !op.p || typeof op.p !== 'object') return fail('bad', 'Malformed update');
    if (!(PERM[op.type] || []).includes(role)) return fail('forbidden', 'Your role cannot do that');
    const H = HANDLERS[op.type];
    if (!H) return fail('unknown', 'Unknown update type');
    const ts = Math.min(Number(op.ts) || now, now + 5000);
    const r = H(st, op.p, { user: user || { id: 'anon', role: 'visitor', name: 'Visitor' }, role, ts, now, opt, op });
    if (r.ok && r.rec && opt.optimistic) r.rec.pending = true;
    return r;
  }

  /* ----------------------------------------------------------- simulation */
  function checkLevel(st, z, now, emit) {
    const nl = lvlHyst(z);
    if (nl === z.level) return;
    const up = nl > z.level, old = z.level;
    z.level = nl;
    if (!emit) return;
    if (up && nl >= 2) pushAlert(st, { auto: true, level: nl, zone: z.id, title: `${z.name} is ${LEVELS[nl].toLowerCase()} risk`, body: `Density ${z.d.toFixed(1)} people/m². ${ADVICE[nl]}` }, now);
    else if (!up && old >= 2 && nl <= 1) pushAlert(st, { auto: true, level: 0, zone: z.id, title: `${z.name} is easing`, body: `Density down to ${z.d.toFixed(1)} people/m².` }, now);
  }
  /* Stand-in for the camera / sensor feed. Real feeds post to /api/sensors/density instead. */
  function simTick(st, now) {
    st.zones.forEach(z => {
      if (z.surgeUntil && now > z.surgeUntil) { z.surgeUntil = 0; z.target = z.base; }
      if (z.extUntil && now < z.extUntil) return;
      z.d = Math.max(0.2, Math.min(7, z.d + (z.target - z.d) * 0.18 + (Math.random() - 0.5) * 0.45));
      z.updated = now; z.source = 'Camera feed';
      pushHist(z, now);
      checkLevel(st, z, now, true);
      const tr = trend(z);
      if (tr.dir === 'rising' && tr.etaMin != null && tr.nextLevel >= 2 && tr.etaMin <= 3 && z.level < 3 && now - (z.fcAt || 0) > 180000) {
        z.fcAt = now;
        pushAlert(st, { auto: true, level: tr.nextLevel, zone: z.id, title: `Forecast: ${z.name} may become ${LEVELS[tr.nextLevel].toLowerCase()} risk in about ${Math.max(1, Math.round(tr.etaMin))} min`, body: `Density is rising about ${tr.slope.toFixed(1)} people/m² per minute. Consider closing entry or redirecting the crowd.` }, now);
      }
    });
    if (st.settings.demoMove) {
      st.tasks.forEach(t => {
        if (t.status !== 'enroute') return;
        const r = st.responders.find(k => k.id === t.assignee);
        if (!r) return;
        const dx = t.x - r.x, dy = t.y - r.y, d = Math.hypot(dx, dy);
        if (d < 12) return;
        const step = Math.min(d, 16);
        r.x = Math.round(r.x + dx / d * step); r.y = Math.round(r.y + dy / d * step); r.locTs = now;
      });
    }
  }
  function ingestDensity(st, readings, now) {
    let n = 0;
    (readings || []).forEach(r => {
      const z = st.zones.find(k => k.id === r.zoneId), d = num(r.d, 0, 12);
      if (!z || d == null) return;
      z.d = d; z.target = d; z.updated = Math.min(Number(r.ts) || now, now); z.source = r.source || 'Authorized sensor'; z.extUntil = now + 30000; z.surgeUntil = 0;
      pushHist(z, now); checkLevel(st, z, now, true); n++;
    });
    return n;
  }

  function pushHist(z, t) { (z.hist = z.hist || []).push([t, +z.d.toFixed(2)]); if (z.hist.length > 30) z.hist.shift(); }

  /* Short-term crowd trend (least-squares slope over the last readings) and time to the next risk level. */
  function trend(z) {
    const h = (z.hist || []).slice(-12), steady = { dir: 'steady', slope: 0, etaMin: null, nextLevel: null };
    if (h.length < 4) return steady;
    const t0 = h[0][0], n = h.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    h.forEach(([t, d]) => { const x = (t - t0) / 60000; sx += x; sy += d; sxx += x * x; sxy += x * d; });
    const den = n * sxx - sx * sx;
    if (den <= 1e-9) return steady;
    const slope = (n * sxy - sx * sy) / den;
    const dir = slope > 0.4 ? 'rising' : slope < -0.4 ? 'falling' : 'steady';
    let etaMin = null, nextLevel = null;
    if (dir === 'rising') { const th = THRESH.find(v => v > z.d); if (th != null) { etaMin = (th - z.d) / slope; nextLevel = THRESH.indexOf(th) + 1; } }
    return { dir, slope, etaMin, nextLevel };
  }

  /* Split the excess crowd of a zone across shelters with free space, nearest (by safe route) first. */
  function evacPlan(st, zoneId) {
    const z = st.zones.find(k => k.id === zoneId);
    const people = Math.max(0, Math.round((z.d - 3.0) * z.area)); // bring the zone back to a comfortable 3 per m²
    const opts = [];
    st.fac.filter(f => f.type === 'shelter' && f.cap - f.occ > 0).forEach(f => {
      const r = computeRoute(st, { x: z.x + z.w / 2, y: z.y + z.h / 2, kind: 'shelter', only: f.id });
      if (r) opts.push({ f, r, room: f.cap - f.occ });
    });
    opts.sort((a, b) => a.r.dist - b.r.dist);
    let left = people; const assign = [];
    opts.forEach(o => { if (left <= 0) return; const n = Math.min(left, o.room); assign.push({ id: o.f.id, name: o.f.name, people: n, dist: o.r.dist, eta: o.r.eta }); left -= n; });
    return { zoneId, people, assign, unplaced: Math.max(0, left) };
  }

  /* Rule-based advice for control-room staff: where to close entry, pre-position ambulances, add volunteers. */
  function recommendations(st) {
    const out = [], add = (level, title, detail, action) => out.push({ level, title, detail, action });
    st.zones.forEach(z => {
      const tr = trend(z), c = { x: z.x + z.w / 2, y: z.y + z.h / 2 };
      const gate = st.gates && st.gates[z.id] && st.gates[z.id].closed;
      const soon = tr.dir === 'rising' && tr.etaMin != null && tr.etaMin <= 5 && tr.nextLevel >= 2;
      if (z.level < 2 && !soon) return;
      const why = z.level >= 2 ? `${LEVELS[z.level]} risk at ${z.d.toFixed(1)} people/m²` : `rising, may reach ${LEVELS[tr.nextLevel].toLowerCase()} risk in about ${Math.max(1, Math.round(tr.etaMin))} min`;
      if (!gate) add(z.level >= 3 ? 3 : 2, `Close entry to ${z.name}`, `It is ${why}. Closing entry stops more people arriving and routes steer around it.`, { type: 'gate', zoneId: z.id, label: 'Close entry' });
      if (z.level >= 3 && !(st.evac && st.evac[z.id])) add(3, `Plan an evacuation of ${z.name}`, `Density is ${z.d.toFixed(1)} people/m². Review the shelter split and issue an order.`, { type: 'evac', zoneId: z.id, label: 'Review plan' });
      let best = null;
      st.fac.filter(f => f.type === 'medical' && f.ambFree > 0).forEach(f => {
        const r = computeRoute(st, { x: f.x, y: f.y, to: c, noHazard: true, service: true });
        if (r && (!best || r.eta < best.eta)) best = { eta: r.eta, f };
      });
      if (!best) add(3, 'No ambulance is ready', `${z.name} is ${why}, and every medical camp has its ambulances out.`);
      else if (best.eta > 4) add(2, `Pre-position an ambulance near ${z.name}`, `The nearest ready ambulance is ${best.eta} min away at ${best.f.name}.`);
      const cover = candidates(st, { skill: 'crowd', x: c.x, y: c.y, tried: [] }).filter(k => k.eta <= 5);
      const pending = st.tasks.some(t => ['unassigned', 'offered', 'accepted', 'enroute', 'onscene'].includes(t.status) && t.title.includes(z.name));
      if (!cover.length && !pending) add(2, `No crowd-control volunteer near ${z.name}`, 'Nobody free is within 5 minutes. Request cover.', { type: 'task', zoneId: z.id, label: 'Request crowd control' });
    });
    st.fac.forEach(f => {
      if (f.type === 'shelter' && f.occ / f.cap >= 0.85) { const alt = st.fac.filter(k => k.type === 'shelter' && k.id !== f.id).sort((a, b) => (b.cap - b.occ) - (a.cap - a.occ))[0]; add(2, `${f.name} is ${Math.round(f.occ / f.cap * 100)}% full`, alt ? `Direct overflow to ${alt.name}, which has room for ${(alt.cap - alt.occ).toLocaleString('en-US')} more.` : 'No other shelter has room.'); }
      if (f.type === 'medical' && f.free / f.beds < 0.15) add(2, `${f.name} is nearly full`, `Only ${f.free} of ${f.beds} beds are free. Divert non-urgent cases to another camp.`);
      if (f.type === 'water' && f.status === 'out') add(1, `${f.name} is out of service`, 'Send a volunteer to check supply and re-open it.');
    });
    return out.sort((a, b) => b.level - a.level).slice(0, 8);
  }

  /* Response-time and workload figures for the after-action view. */
  function insights(st) {
    const acc = [], scene = [], T = st.tasks; let esc = 0;
    T.forEach(t => {
      const a = t.timeline.find(e => e.ev === 'accepted'), o = t.timeline.find(e => e.ev === 'onscene');
      if (a) acc.push(a.ts - t.createdTs);
      if (o) scene.push(o.ts - t.createdTs);
      esc += t.timeline.filter(e => e.ev === 'timeout' || e.ev === 'declined').length;
    });
    const avg = a => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length / 1000) : null);
    const byType = {}; st.inc.forEach(i => { byType[i.type] = (byType[i.type] || 0) + 1; });
    const beds = st.fac.filter(f => f.type === 'medical'), sh = st.fac.filter(f => f.type === 'shelter');
    const sum = (a, k) => a.reduce((x, f) => x + f[k], 0);
    const rs = { available: 0, busy: 0, offered: 0, off: 0 }; st.responders.forEach(r => { rs[responderStatus(st, r)]++; });
    return {
      tasks: T.length, done: T.filter(t => t.status === 'done').length, active: T.filter(t => ACTIVE.includes(t.status)).length, waiting: T.filter(t => ['unassigned', 'offered'].includes(t.status)).length,
      escalations: esc, avgAcceptSec: avg(acc), avgSceneSec: avg(scene), within5: scene.length ? Math.round(scene.filter(v => v <= 5 * 60000).length / scene.length * 100) : null,
      incidents: st.inc.length, open: st.inc.filter(i => i.status !== 'Resolved').length, byType,
      peaks: st.zones.map(z => ({ id: z.id, name: z.name, peak: Math.max(z.d, ...(z.hist || []).map(h => h[1])), level: z.level })).sort((a, b) => b.peak - a.peak),
      bedsUsedPct: Math.round((1 - sum(beds, 'free') / sum(beds, 'beds')) * 100), shelterUsedPct: Math.round(sum(sh, 'occ') / sum(sh, 'cap') * 100), responders: rs
    };
  }

  /* GIS interchange: zones, facilities, incidents and designated routes as GeoJSON (WGS84). */
  function geojson(st) {
    const ll = (x, y) => [+(81.83 + x * 0.000025).toFixed(6), +(25.44 - y * 0.0000225).toFixed(6)];
    const N = nodes(st), f = [];
    st.zones.forEach(z => f.push({ type: 'Feature', properties: { kind: 'zone', id: z.id, name: z.name, density: +z.d.toFixed(2), level: LEVELS[z.level], entryClosed: !!(st.gates && st.gates[z.id]), updated: new Date(z.updated).toISOString(), source: z.source },
      geometry: { type: 'Polygon', coordinates: [[ll(z.x, z.y), ll(z.x + z.w, z.y), ll(z.x + z.w, z.y + z.h), ll(z.x, z.y + z.h), ll(z.x, z.y)]] } }));
    st.fac.forEach(a => f.push({ type: 'Feature', properties: { kind: 'facility', id: a.id, type: a.type, name: a.name, updated: new Date(a.upd).toISOString() }, geometry: { type: 'Point', coordinates: ll(a.x, a.y) } }));
    st.inc.forEach(i => f.push({ type: 'Feature', properties: { kind: 'incident', id: i.id, type: i.type, severity: i.sev, status: i.status, reported: new Date(i.ts).toISOString() }, geometry: { type: 'Point', coordinates: ll(i.x, i.y) } }));
    (st.routes || []).forEach(r => f.push({ type: 'Feature', properties: { kind: 'route', id: r.id, name: r.name, routeType: r.kind, direction: r.dir, status: r.status }, geometry: { type: 'LineString', coordinates: r.path.filter(id => N[id]).map(id => ll(N[id].x, N[id].y)) } }));
    return { type: 'FeatureCollection', name: 'cdert', features: f };
  }

  /* What a visitor may know about the help for their SOS (no names or notes). */
  function helpFor(st, inc) {
    const t = st.tasks.filter(k => k.incidentId === inc.id && k.status !== 'cancelled').sort((a, b) => b.createdTs - a.createdTs)[0];
    if (!t) return { help: inc.status === 'Resolved' ? 'done' : 'finding', eta: null };
    const map = { offered: 'finding', unassigned: 'finding', accepted: 'assigned', enroute: 'enroute', onscene: 'onscene', done: 'done' };
    let eta = null;
    if (['accepted', 'enroute'].includes(t.status)) { const r = st.responders.find(k => k.id === t.assignee); eta = r ? Math.max(1, Math.round(Math.hypot(r.x - t.x, r.y - t.y) * SCALE / 1.1 / 60)) : t.etaMin; }
    return { help: map[t.status] || 'finding', eta };
  }

  return { migrateState, trend, evacPlan, recommendations, insights, geojson, helpFor, SCALE, LEVELS, THRESH, INC, KINDS, SKILLS, ACTIVE, PERM, uid, clone, lvlRaw, geo, zoneAt, seedState, nodes, computeRoute, candidates, responderStatus,
    applyOp, sweep, simTick, ingestDensity, dispatch, pushAlert };
});
