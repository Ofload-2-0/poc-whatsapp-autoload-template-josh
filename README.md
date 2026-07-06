# WhatsApp Pickup Confirmation — POC

Automated WhatsApp pickup-confirmation for Ofload carriers. A cron finds loads past
their pickup time, WhatsApps the assigned driver/carrier contact (via HubSpot) to
confirm pickup, and records the outcome back on the load (milestone / note / history).

Replaces the operator-driven browser-injection POC with a proper backend service.

## Docs
- **`WORKFLOW.md`** — the full flow, phone waterfall, templates, state machine, integration points
- **`DEPLOY.md`** — deployment notes (2 Lambdas: cron + webhook)
- **`INJECT.md`** — read-only dev dashboard/overlay for demos

## Layout
| File | Role |
|---|---|
| `config.js` | env config — fail-closed gating + safety caps |
| `db.js` | READ-ONLY eligibility query + carrier contacts (EOS `eos` DB) |
| `phone.js` | driver phone waterfall + AU-mobile validation |
| `hubspot.js` | contact match, set tokens, send the two templates |
| `eos.js` | EOS API write-backs (Start Job / On The Road / Note) |
| `tracking.js` | isolated state store (local JSON / DynamoDB) |
| `pickupMonitor.js` | cron Lambda — find eligible → send |
| `pickupReplyWebhook.js` | webhook Lambda — reply → classify → write-back |
| `test/` | unit tests (`npm test`) |
| `send-one.js/.sh`, `check-reply.js/.sh`, `validate*.js/.sh`, `seed.js`, `demo.js`, `serve.js` | dev/test tooling |

## Safety model (fail-closed)
- **Allowlist** — `WA_PHASE=carrier` + `WA_ENABLED_CARRIERS`; empty = sends nothing; `all` double-locked behind `WA_ALLOW_ALL=yes`.
- **`WA_MAX_SENDS`** — hard cap on sends per run (default 1).
- **`WA_DRY_RUN`** (sends) and **`WA_EOS_DRY_RUN`** (write-backs) — independent kill switches.

Copy `.env.example` → `.env` and fill in real values (never commit `.env`).

## Status
Comms flow (send + both reply branches) validated on real dev data. Remaining before prod:
EOS API credentials for real write-backs, the ETA template approval, and deployment.
See `WORKFLOW.md` for the live checklist.
