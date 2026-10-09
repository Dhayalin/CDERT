# CDERT: Crowd Disaster & Emergency Resource Tracker

An offline-capable, mobile-first emergency coordination platform for large gatherings such as the Kumbh Mela.
Full stack: Node backend, REST + live updates, role-based web app (installable PWA), shared rules engine.

```
npm start      # http://localhost:3000  (Node 18+, no npm install needed)
npm test       # 30 tests: rules, API, roles, offline sync, signing, Vercel handler
```
Demo sign-in is one tap. PINs: `1234` for volunteers and medical staff, `admin` for the administrator.

## How the abstract is covered

| Abstract says | What is built |
|---|---|
| Offline-capable, mobile-based | Service worker caches the app; last snapshot and an outbox live on the device; installable PWA |
| Pre-downloaded maps, **designated routes**, facilities, medical camps, shelters, services | Map pack with 10 facility types, **one-way pilgrim routes, an ambulance corridor, route closures** (admin), offline "offline pack" screen |
| GIS-based crowd-risk mapping | 7 zones with density-based Safe / Watch / High / Critical levels, hatching for colour-blind use, **GeoJSON export** for QGIS / ArcGIS |
| Crowd density from authorized sources, risk levels and alerts | `POST /api/sensors/density` (API-key protected); automatic alerts with hysteresis; **trend and forecast** ("High risk in about 2 min") |
| Real-time incident management | Reports, SOS, status flow, severity, timestamp + location on every update |
| Identify affected location, **safer evacuation routes**, direct people to medical facilities, camps, resources | Risk-weighted routing around crowded zones, open incidents, closed routes and closed entries; **evacuation planner** that splits a crowd across shelters by free space; visitors get "Route me to safety" |
| Role-based architecture | Visitor, Volunteer, Medical team, Administrator. Enforced on the server. Visitors never see responder identities |
| Volunteers, medical teams and administrators update conditions, incidents, resources, notifications | Crowd readings, incident reports, bed / ambulance / shelter / water updates, broadcasts, **volunteer task dispatch** with offers, timeouts and escalation |
| Local storage and synchronization | Outbox with idempotent batch sync; timestamps decide conflicts; late offline accepts are honoured |
| Timestamp and location on every update; freshness and reliability | Fresh / Aging / Stale labels everywhere; ground reports kept next to sensor data |
| **Reduce response time** | Auto-dispatch to the nearest suitable responder; **Insights** tab: time to accept, time to scene, % within 5 min |
| **Prevent crowd incidents** | Forecast alerts, "Close entry" gates, recommended actions for control-room staff |
| **Efficient deployment of essential services** | Recommendations: pre-position ambulances, request crowd control, shelter overflow, low beds, water outages |
| Connectivity-resilient | Offline mode, **signed bulletins shared between nearby devices** (ECDSA P-256, verified in the browser) |
| Low-cost, scalable | Zero npm dependencies; runs on a single small server or on Vercel + Redis |

Extras for visitors: **SOS tracking** ("A responder is on the way, about 3 min"), and an offline **safety guide in English and Hindi**.

## Architecture
```
public/engine.js   shared rules (permissions, task state machine, routing, evacuation, forecasts, analytics)
lib/core.js        routes, auth, role-filtered views, exports, signed bulletins (used by both hosts)
lib/sign.js        ECDSA P-256 signing
server.js          long-running host: Server-Sent Events + timers + JSON-file storage
api/[...path].js   Vercel host: Redis storage, lazy simulation, polling
public/app.js      client: outbox, optimistic replay, role-based UI, map, nearby sharing
```
The browser replays the outbox over the last snapshot with the **same engine** the server uses, so offline changes
look right immediately and are flagged "Pending sync".

### Offline sync rules
* Every change is `{id, type, p, ts}`. The server applies it with the caller's real role, never what the client claims.
* Idempotent: re-sending a batch never double-applies.
* **Timestamps decide, not arrival order.** An *Accept* tapped offline before an offer expired is honoured even if the
  offer was already passed to someone else; one made after expiry is rejected with a clear message.
* Resource edits are last-write-wins by timestamp; stale edits are refused and the person is told.
* A ground report older than the sensor reading is kept as a note, not allowed to overwrite it.

### Nearby-device sharing
Each snapshot carries a **bulletin**: crowd levels, alerts, closures and evacuation orders, signed by the server.
A device with no signal asks nearby devices; any that have a newer bulletin pass it on. The receiver verifies the
signature with the cached public key (WebCrypto) and rejects forgeries and replays of older bulletins.
The demo transport is BroadcastChannel (tabs of one browser). A field build would carry the same bulletins over
Bluetooth LE or Wi-Fi Direct; the signing and verification code does not change.

## Demo script (two or three windows)
1. Window A: **Administrator**. Window B: **Volunteer** (Asha). Window C: **Visitor**.
2. A: Sync tab, *Start surge* on Sangam Ghat. Watch the forecast alert, then High / Critical, and the *Recommended actions* list.
3. A: tap the zone, review the evacuation plan, *Issue evacuation order*. C sees the order and taps *Route me to safety*.
4. A: Resources tab, *Close route* on the Return route. Routes re-plan and the map shows the closure.
5. C: Get help, *Send SOS*. A auto-dispatches the nearest responder; B gets an offer, accepts (try it offline), and C sees the status change.
6. A: Insights tab for response times; Export GeoJSON.
7. B: Sync tab, *Simulate no signal*. In another tab, keep an online session open and press *Ask nearby* to see a signed bulletin arrive.

## API
| Method & path | Who | Purpose |
|---|---|---|
| `GET /api/state` | anyone (filtered by role) | Snapshot incl. signed bulletin |
| `GET /api/events` | anyone | SSE stream (`server.js` only) |
| `POST /api/sync` | anyone (per-op role checks) | Batch of queued operations |
| `POST /api/login`, `/api/logout` | | PIN sign-in, bearer token, rate-limited |
| `GET /api/pubkey` | anyone | Public key for bulletin verification |
| `POST /api/sensors/density` | `x-api-key` | Authorized monitoring feed `{readings:[{zoneId,d,ts?,source?}]}` |
| `POST /api/admin/demo`, `/reset` | admin | Surge, calm, reset |
| `GET /api/export/geojson`, `incidents.csv`, `tasks.csv` | admin | GIS and after-action review |

Operations: `incident.create/status`, `zone.reading`, `fac.update`, `alert.broadcast`,
`task.create/assign/respond/progress/cancel`, `vol.update`, `settings.update`,
`route.set`, `zone.gate`, `evac.order/clear`.

`curl -X POST localhost:3000/api/sensors/density -H 'x-api-key: demo-sensor-key' -H 'content-type: application/json' -d '{"readings":[{"zoneId":"Z1","d":5.6}]}'`

## Deploying to Vercel
`server.js` needs a long-running process, which Vercel does not provide, so the repo includes a serverless host
(`api/[...path].js` + `vercel.json`) running the same core.

| | `server.js` (Render, Railway, Fly, VPS) | `api/[...path].js` (Vercel) |
|---|---|---|
| State | memory + JSON file | Redis (Upstash) |
| Simulation, offer timeouts | timers | catch up lazily on each request |
| Live updates | Server-Sent Events | client polls every 4 s |

1. Push this folder to GitHub (or use the Vercel CLI).
2. Vercel: **Add New, Project**, import the repo. Framework: Other. No build command. Output directory `public` (already in `vercel.json`).
3. Project **Storage** tab: add **Upstash Redis** from the Marketplace and connect it (injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`).
4. Settings, Environment Variables: set `SENSOR_KEY` to a long random string. Optional `DEMO=0` hides PIN hints on the sign-in list.
5. Deploy. Open the URL on two devices. HTTPS (which Vercel gives you) is required for the service worker and signature checks.

Without Redis the handler uses memory, which resets between invocations on Vercel. Always attach Redis.

## Configuration
`PORT` (3000), `DATA_FILE` (data/db.json), `SENSOR_KEY` (demo-sensor-key), `DEMO=0`.

## Honest limits of this prototype
* The map is a schematic SVG with approximate coordinates, not real tiles or live GPS. For production use MapLibre with an
  offline tile pack; the engine only needs node coordinates.
* The crowd simulation stands in for cameras and sensors until a real feed posts to `/api/sensors/density`.
* Nearby sharing is demonstrated between browser tabs; Bluetooth / Wi-Fi Direct transport is not included.
* Demo PINs, tokens in export links, and a single JSON blob in Redis are fine for a pilot, not for an event with
  thousands of concurrent phones. Use real identity (OTP or SSO), a proper database and a CDN.
* Evacuation numbers are planning aids that assume density x area; they do not replace trained crowd-safety staff.
