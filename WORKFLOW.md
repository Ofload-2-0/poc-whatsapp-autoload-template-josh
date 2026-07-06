# WA Pickup Confirmation — Build Spec (v2 — finalised flow)

Automated, backend-integrated replacement for the operator-driven POC.
Schema verified read-only against dev `Ofload_site` (2026-07-06).

**Actors:** Ofload service (cron + webhook) · Carrier contact (WhatsApp) · HubSpot (send + reply channel) · Platform / adminapi (source of truth)

---

## Flow (per the approved diagram)

```
CRON (5 min)
  │
(1) Find loads requiring milestone tracking
  ▼
(2) Load already 'On the Road'?  ── yes ──► NO ACTION
  │ no
(3) Past 2h since pickup time?   ── not yet ──► NO ACTION
  │ yes
(4) SEND WA "Have you picked up this load?"  [Yes] [No]
  │      └─ record History: "Pickup check sent to WhatsApp"
  ▼
(5) Driver replies:
    ├─ "Yes, it's been picked up"
    │     → Simulate Start Job + set load 'On the Road' + pickup_time = message timestamp
    │     → record History  ✔ finished
    │
    ├─ "No, not yet"
    │     → SEND follow-up "What is your ETA for picking up this load?"
    │        buttons: [< 1 hour] [1–2 hours] [> 2 hours]
    │     → on ETA reply: add Note + record History
    │        (if "> 2 hours": Note "Driver running more than 2 hours late")  ✔ finished
    │
    └─ No response  → record History  ✔ finished
```

## Phone resolution — WATERFALL (stop at first match; skip invalid numbers throughout)

1. **Assigned team member on the load** — the per-load "assign to team member" the carrier sets. If present → use that person's phone.
2. **Single valid contact** — if the carrier has exactly one contact with a valid phone → use it. (Filter out bad/placeholder numbers, e.g. integration/accounts entries.)
3. **By role priority** (multiple contacts, none assigned): **Director → Manager → Accounts → any Driver.**

"Valid phone" = passes AU mobile validation before we attempt a send. Then the chosen
phone is matched to a HubSpot contact (POC's `findContact`) to actually send.

**Resolution path in data:** `shipment.logistics_id → carrier.logistics_id → carrier.company_id → team (company_id)`.
Per-load assignment source = TBD (see Dependency P4). `team.phone` is the number field
(NOT `mobile_phone`, which is unused). `team.position` drives the role priority.

## Templates (HubSpot, Meta-approved, button-based)

**T1 — Pickup confirmation:** "Have you picked up load {{load_reference}}?" → **[Yes, it's been picked up] [No, not yet]**
**T2 — ETA follow-up (only on "No"):** "What is your ETA for picking up {{load_reference}}?" → **[< 1 hour] [1–2 hours] [> 2 hours]**

## Write-backs — all via EXISTING app features (not raw SQL)

| Trigger | Write | Detail |
|---|---|---|
| WA sent | **History** | `Pickup check sent to WhatsApp` · Role=System · Name=WhatsApp |
| Reply "Yes" | **Milestone/status** | Simulate **Start Job** + set **On the Road** + `pickup_time` = message timestamp |
| Reply "Yes" | **History** | `Start job` / load on the road · System · WhatsApp |
| Reply "No" + ETA | **Note** | Category `WhatsApp | Late Pickup`, created by System/WhatsApp, desc e.g. `Driver confirmed not yet picked up. ETA < 1 hour`; visible-to-shipper option |
| Reply "No" + ETA | **History** | e.g. `Driver not picked up. ETA < 1 hr` · System · WhatsApp |
| No response | **History** | record the no-response outcome |

## State machine (per shipment — isolated tracking store)
```
ELIGIBLE → WA_SENT → AWAITING_REPLY
   ├─ "Yes" → ON_THE_ROAD (Start Job + pickup time + History) ✔
   ├─ "No"  → FOLLOWUP_SENT → AWAITING_ETA → ETA_RECORDED (Note + History) ✔
   └─ no response (timeout) → NO_RESPONSE (History) ✔
```

## Observability (build first)
- Isolated tracking store (DynamoDB) — touches no shipment data.
- Debug dashboard (`debug-dashboard.html`) reads it: live per-shipment stage + timestamps.
- Structured CloudWatch logs per transition. DRY_RUN mode = no sends/writes.

## Deployment
`platform-dev` (958254112077), same VPC as DB. 2 Lambdas (cron + webhook) from one zip.

---

## Open decisions (Josh)
- **D1 — RESOLVED:** phone = waterfall above (assigned → single valid → Director/Manager/Accounts/Driver).
- **D2 — RESOLVED:** No → ETA buttons (<1h / 1–2h / >2h) → Note + History; >2h note = "running >2h late".

## Integration points — RESOLVED via EOS API (repo: Ofload-2-0/ofload_site)
All write-backs go through supported carrier API endpoints (auth: `auth.api` bearer token
via `POST /api/authorize` with client creds). No raw SQL.

- **Start Job + pickup time (YES):** `POST /api/carrier/team/{teamId}/shipment/{manifestId}/status`
  body `{ "status": "is_begin", "actual_time": "<msg timestamp>" }`
  → creates `BeginFulfillment` milestone + sets cargo pickup time (`updateCargoToBegin`). Idempotent.
- **On The Road milestone:** same endpoint, pass explicit `milestone` = the On-The-Road enum
  (`ShipmentMilestoneEnum::EVENT_SHIPMENT_ON_THE_ROAD`) instead of/after `status`.
  Controller: `app/Http/Controllers/Api/Carrier/ShipmentController.php::updateShipmentStatus` (line 291).
- **Note (NO/ETA):** `POST /api/admin/shipnotes` (`ShipmentNotesController::store`) supports
  `note_category`, `note_sub_category`, `visible_to_shipper`, `note_data` (severity, date). Simpler
  carrier route: `POST /api/carrier/team/{teamId}/shipment/{id}/note`.
- **Team assignment read (waterfall step 1):** `master_manifest.team_id` (+ `team_assign` table) →
  `team.phone`. Assignment API: `POST /api/carrier/team/{teamId}/shipment/{masterManifestId}/assign`.
- **History tab = the `shipment_milestones` table** (milestone-driven; also Altek/Accountant audit).

## Remaining refinements / open items
- **R1 — exact "On The Road" call:** confirm whether YES = `is_begin` alone (Start Job + pickup time) or also an explicit `On The Road` milestone; and whether On-The-Road auto-progresses. (Read code / confirm w/ backend.)
- **R2 — Note category mapping:** enum has no "WhatsApp/Late Pickup" — map late-pickup to `ETA` (or `OTHER`) with `visible_to_shipper`. Confirm desired category.
- **R3 — custom History lines** ("Pickup check sent to WhatsApp", "No response"): History is milestone-driven, so arbitrary text needs either new milestone types (backend change) or we record those steps as Notes. Confirm approach.
- **P5 — API credentials:** obtain an integration API client_id/token for the EOS API (backend/ops).
- **P1 — HubSpot contact coverage:** the chosen phone must exist as a HubSpot contact to send.
- **P3 — rotate** the leaked HubSpot token.

## Implementation (built — DRY_RUN, nothing deployed)
| File | Role |
|---|---|
| `config.js` | env config (DRY_RUN on by default, fail-closed gating) |
| `db.js` | READ-ONLY: eligibility query + carrier contacts (⚠️ DRAFT joins marked CONFIRM) |
| `phone.js` | phone waterfall + AU-mobile validation (pure, tested) |
| `hubspot.js` | contact lookup + both templates (T1 confirm, T2 ETA) |
| `eos.js` | EOS API client: startJob / onTheRoad / addNote (DRY_RUN logs only) |
| `tracking.js` | isolated state store (local JSON now; DynamoDB TODO for prod) |
| `pickupMonitor.js` | cron handler — eligible → phone → send → track |
| `pickupReplyWebhook.js` | webhook — Yes/No/ETA branches → EOS write-backs → track |
| `test/logic.test.js` | 13 tests (waterfall, validation, classifiers) — all pass |
| `demo.js` / `serve.js` | local dry-run demo + dashboard server (no DB/network) |
| `debug-dashboard.html` | live dashboard (reads /api/tracking) |
| `build.sh` | Lambda zip |

Run locally: `node demo.js` → `npm run serve` → http://localhost:4599.
Before DRY_RUN can be turned off: validate `db.js` joins (CONFIRM markers) against dev,
resolve R1/R2/R3, obtain EOS API creds (P5), confirm HubSpot coverage (P1), rotate token (P3).
`migration.sql` removed (not needed — write-backs go via API, not DB alters).
