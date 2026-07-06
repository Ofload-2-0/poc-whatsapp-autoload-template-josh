# WA Pickup Monitor — Deploy Guide

Two Lambdas from **one zip** (`./build.sh` → `wa-pickup-monitor.zip`):
- `pickupMonitor.handler` — EventBridge cron (every 5 min)
- `pickupReplyWebhook.handler` — API Gateway POST (HubSpot reply webhook)

## ✅ Done (built + tested locally)
- HubSpot integration (`hubspot.js`) — complete, tested in POC
- All 5 DB functions implemented (`db.js`, node-postgres)
- Fail-closed carrier/load gating + **double-gated `all`** (needs `WA_ALLOW_ALL=yes`)
- Reply classifier fixed (negation bug: "not picked up" no longer read as YES)
- 12 local tests pass (`npm test`) — no live infra needed
- Deployable zip builds (`./build.sh`)

## ⚠️ Before going live — verify these
1. **Schema check** — confirm the real `adminapi` table/column names match `db.js` CFG
   defaults (`loads`, `carriers`, `carrier_id`, `mobile`, status `Allocated`/`On the Road`).
   Any mismatch → override via `DB_*` env vars, no code change.
2. **Run `migration.sql`** to add the `wa_*` columns.
3. **Rotate the HubSpot token** that leaked in the old `.env.example`.
4. **Confirm the HubSpot reply webhook payload shape** and adjust `parsePayload()` if needed.

## AWS setup (target: Platform-Dev `958254112077` for test)
DB is private in **vpc-0c510a5b42ce6cb9a** → both Lambdas need VPC config:
- Subnets: `subnet-0ba70208ee7d7272d`, `subnet-0d4667dcf29361928`, `subnet-0888bce647c3bab1d`
- A security group allowed to reach the DB SG `sg-0d208520263786cea` on 5432
- DB endpoint: `dev-ofload-db-dbcluster-apbpjssrmca2.cluster-cnxvdokgi8pl.ap-southeast-2.rds.amazonaws.com`
- Runtime: Node.js 20.x

### Env vars (both Lambdas)
| Var | Test value | Prod value |
|---|---|---|
| `DATABASE_URL` | postgres://postgres:***@<endpoint>:5432/adminapi | (Secrets Manager) |
| `HUBSPOT_TOKEN` | rotated pat-ap1-… | (Secrets Manager) |
| `HUBSPOT_WEBHOOK_URL` | https://api-ap1.hubapi.com/automation/v4/webhook-triggers/23384711/<trigger> | same |
| `TRIGGER_AFTER_MS` | `0` | `7200000` |
| `WA_PHASE` | `carrier` | `carrier` |
| `WA_ENABLED_CARRIERS` | `<one test carrier id>` | `<approved carriers>` |
| `WA_DRY_RUN` | `yes` (first run — logs, no send) | unset |
| `WA_UNRECOGNISED` | `yes` or `ignore` | decide |

### Triggers
- `pickupMonitor` → EventBridge rule `rate(5 minutes)`
- `pickupReplyWebhook` → API Gateway (HTTP POST); put the URL into the HubSpot
  workflow `milestone_tracking_load_picked_up` as the incoming-message webhook action.

## Test sequence (dev)
1. Deploy zip to both Lambdas + VPC + env (`WA_DRY_RUN=yes`, one carrier).
2. Invoke `pickupMonitor` manually → confirm it finds only the allowlisted carrier's loads (dry-run logs).
3. Remove `WA_DRY_RUN`, real load → WhatsApp arrives → reply YES → load = On the Road; test NO path.
4. Confirm no other carriers touched (check logs). Then promote to prod with the approved allowlist.
