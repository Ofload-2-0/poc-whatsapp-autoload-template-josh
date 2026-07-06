# WA Pickup Confirmation — Lambda Handover

## What this does
Checks if a load is still Allocated 2+ hours after its scheduled pickup time → sends a WhatsApp to the carrier asking them to confirm pickup. 

- YES reply → load moves to On the Road + actual pickup time recorded
- NO reply → left as-is for now

No UI component. Just a cron + webhook.

## Files

| File | Purpose |
|------|---------|
| `pickupMonitor.js` | Cron Lambda — queries loads, sends WA |
| `pickupReplyWebhook.js` | Webhook Lambda — receives HubSpot reply, updates load |
| `hubspot.js` | HubSpot API calls — no changes needed |
| `.env.example` | Environment variables |

## What you need to implement

**`pickupMonitor.js`**
- `getEligibleLoads()` — DB query for Allocated loads past threshold
- `markWaSent()` — set `wa_sent = true` + store HubSpot contact ID on the load

**`pickupReplyWebhook.js`**
- `getLoadByContactId()` — find load by `wa_contact_id`
- `updateLoadOnTheRoad()` — set status to On the Road + actual pickup time
- `markLoadDeclined()` — record the NO reply

## DB columns to add to loads table

```sql
ALTER TABLE loads ADD COLUMN wa_sent         BOOLEAN   DEFAULT false;
ALTER TABLE loads ADD COLUMN wa_sent_at      TIMESTAMP;
ALTER TABLE loads ADD COLUMN wa_contact_id   VARCHAR;
ALTER TABLE loads ADD COLUMN wa_reply        VARCHAR;
ALTER TABLE loads ADD COLUMN wa_replied_at   TIMESTAMP;
```

## AWS setup

**pickupMonitor** — EventBridge cron
```
rate(5 minutes)
```

**pickupReplyWebhook** — API Gateway POST endpoint
Public URL goes into HubSpot as the webhook action on incoming WhatsApp message.

## HubSpot setup

The existing workflow (`milestone_tracking_load_picked_up`) already sends the WA template with Yes/No buttons — triggered by `pickupMonitor`.

Add one action to handle the reply: when an incoming WhatsApp message is received, POST to the `pickupReplyWebhook` URL with contact ID + message text. Check the HubSpot webhook tester to confirm the exact payload shape and adjust field paths in `pickupReplyWebhook.js` accordingly.

## Phased rollout (env vars only, no code changes)

**Phase 1 — POC (specific loads):**
```
WA_PHASE=load
WA_ENABLED_LOADS=AUSTPUXDHAW,AUSTEDK6VE8
```

**Phase 2 — specific carriers:**
```
WA_PHASE=carrier
WA_ENABLED_CARRIERS=carrier_id_1,carrier_id_2
```

**Phase 3 — everyone:**
```
WA_PHASE=all
```

## Notes
- `hubspot.js` is complete — token and webhook URL are working from POC testing
- Set `TRIGGER_AFTER_MS=0` for testing, `7200000` for production (2 hours)
- Monitor is idempotent — `wa_sent = true` prevents double-firing on the same load
