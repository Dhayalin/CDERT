# CDERT — Sample Test Cases

These are functional test cases for the Crowd Disaster & Emergency Resource Tracker (CDERT). They are implementation-neutral and should be mapped to the actual UI/API as it evolves.

**Important:** These tests use fictional demonstration data. Test with a staging environment and simulated incidents only. Do not use this dataset to direct real-world emergency response.

## Preconditions
- The application is running in a development or staging environment.
- The sample records in `sample_data.json` are loaded, or equivalent fixtures are created.
- Test accounts use mock authentication; never store real passwords in test fixtures.
- For offline tests, use browser/device network controls or a controlled test network.

## Test cases

| ID | Area | Steps / Input | Expected result | Priority |
|---|---|---|---|---|
| TC-001 | Visitor access | Sign in as an active `VISITOR` user. | Visitor safety information, maps and facility locations are visible; administrative controls are hidden. | High |
| TC-002 | Role-based access | Sign in as `VOLUNTEER`; attempt to open an admin-only user-management route. | Access is denied in both UI and server/API authorization; hiding a button alone is not sufficient. | Critical |
| TC-003 | Medical-team permissions | Sign in as `MEDICAL_TEAM`; update a medical facility's resource count. | Authorized update is accepted and audit metadata is recorded. | High |
| TC-004 | Inactive account | Attempt sign-in using the disabled demo account `VOL-099`. | Authentication is rejected and no protected data is exposed. | High |
| TC-005 | Crowd risk — low | Load zone `Z001` with density 42%. | Zone displays LOW risk according to configured thresholds. | High |
| TC-006 | Crowd risk — high | Load zone `Z002` with density 78%. | Zone displays HIGH risk and the configured warning/alert is generated once. | Critical |
| TC-007 | Crowd risk — critical | Load zone `Z003` with density 91%. | Zone displays CRITICAL risk and restricted status; configured escalation is triggered. | Critical |
| TC-008 | Invalid density | Submit a density value of -1 or 101. | Input is rejected with validation feedback; invalid values are not persisted. | High |
| TC-009 | Incident creation | Submit a valid incident with type, severity, location and timestamp. | Incident receives a unique ID, is shown to authorized roles, and is recorded with reporter and status. | Critical |
| TC-010 | Missing required fields | Submit an incident without type or location. | Submission is blocked or returns a clear validation error; no incomplete incident is saved. | High |
| TC-011 | Incident status transition | Change an open incident to `IN_PROGRESS`, then `RESOLVED`. | Valid transitions persist and history/audit information is retained. | High |
| TC-012 | Duplicate submission | Double-tap submit or retry the same request after a timeout. | The system avoids creating duplicate incidents where idempotency is supported, or clearly identifies duplicates. | High |
| TC-013 | Facility availability | Open facility `F003`, whose available capacity is zero. | Facility is shown as FULL/unavailable and is not recommended as an available destination. | Critical |
| TC-014 | Resource update validation | Set `R001` quantity to a valid non-negative integer, then try -5. | Valid quantity is saved; negative quantity is rejected. | High |
| TC-015 | Offline read access | Load/download maps and facility data, disconnect the network, and reopen the relevant screen. | Previously cached essential information remains accessible with an offline indicator. | Critical |
| TC-016 | Offline incident capture | While offline, create a valid incident. | Incident is stored locally with a pending-sync marker and is not falsely shown as server-synced. | Critical |
| TC-017 | Reconnection and sync | Reconnect after TC-016. | Pending update synchronizes, server acknowledges it, and the local item changes to synced without duplication. | Critical |
| TC-018 | Sync conflict | Change the same record locally and on the server before syncing. | Conflict follows a documented policy; no update is silently lost and the outcome is visible to authorized users. | High |
| TC-019 | Stale data | Load a record with an old `last_updated` timestamp. | UI indicates that the information may be stale and displays its update time. | High |
| TC-020 | Network failure | Force a request timeout or server error. | App handles failure gracefully, preserves unsent data, and offers retry without claiming success. | High |
| TC-021 | Map coordinates | Load each zone and facility from the sample data. | Valid coordinates are plotted at the corresponding locations; invalid coordinates are rejected. | High |
| TC-022 | Unsafe route handling | Mark a route/zone as restricted in test data. | The route is not presented as a safe recommended route; the app explains that route guidance depends on current verified data. | Critical |
| TC-023 | Alert delivery | Trigger a configured high/critical risk event in staging. | Alert reaches only intended recipients, includes severity/time/zone, and avoids repeated alert storms for one unchanged event. | High |
| TC-024 | Privacy and data minimization | Open incident details as a visitor and as an administrator. | Sensitive incident/person details are hidden from unauthorized roles; access is logged where appropriate. | Critical |
| TC-025 | Timestamp handling | Submit timestamps with valid UTC offsets and an invalid timestamp. | Valid timestamps are stored consistently and displayed in local time; invalid timestamps are rejected. | Medium |
| TC-026 | Empty state | Load a zone with no incidents or a facility with no resource records. | UI displays a useful empty state without crashing. | Medium |
| TC-027 | Large data set | Load a staging fixture with many zones/incidents. | Lists/maps remain usable; pagination or clustering is applied if implemented. | Medium |
| TC-028 | Audit trail | Update incident severity and resource quantity. | Authorized audit history records actor, action and timestamp without exposing secrets. | High |

## Suggested acceptance criteria
- All Critical and High tests pass before a demo involving simulated emergencies.
- Authorization is enforced by the backend, not only by frontend route visibility.
- Offline-created records survive app reloads and sync safely after connectivity returns.
- Crowd-risk thresholds are configurable and documented; values in the sample data are illustrative, not validated safety thresholds.
- The UI distinguishes live, cached, stale, pending-sync and successfully synchronized data.
- Test logs and screenshots contain no real personal information or credentials.

## Notes
- The coordinates are approximate illustrative coordinates for map testing, not operational guidance.
- Risk levels and incident severities are synthetic.
- These cases describe expected behavior; they do not claim that the current implementation already passes them.
