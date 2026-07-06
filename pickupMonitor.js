/**
 * pickupMonitor.js — Cron Lambda (EventBridge, every 5 min).
 *
 * Finds eligible shipments → resolves the driver/carrier phone (waterfall) →
 * matches a HubSpot contact → sends the pickup-confirmation template → tracks state.
 *
 * DRY_RUN (default): logs what it WOULD do, sends nothing, writes nothing.
 */
const cfg = require('./config');
const db = require('./db');
const hubspot = require('./hubspot');
const { resolvePhone } = require('./phone');
const tracking = require('./tracking');
const { STAGE } = tracking;

exports.handler = async () => {
  console.log(`[WA Monitor] phase=${cfg.PHASE} dry_run=${cfg.DRY_RUN} offset=${cfg.TRIGGER_AFTER_MS}ms`);

  let loads;
  try {
    loads = await db.getEligibleShipments();
  } catch (err) {
    console.error('[WA Monitor] eligibility query failed:', err.message);
    return { statusCode: 500, body: 'DB query failed' };
  }
  console.log(`[WA Monitor] ${loads.length} eligible shipment(s)`);

  // Blast-radius guard: never send more than MAX_SENDS in one run.
  if (loads.length > cfg.MAX_SENDS) {
    console.warn(`[WA Monitor] capping to MAX_SENDS=${cfg.MAX_SENDS} of ${loads.length} eligible (raise WA_MAX_SENDS to widen). Not-sent this run: ${loads.slice(cfg.MAX_SENDS).map(l => l.reference).join(', ')}`);
    loads = loads.slice(0, cfg.MAX_SENDS);
  }

  const results = { sent: [], skipped: [], failed: [] };

  for (const load of loads) {
    const ref = load.reference;
    try {
      // ── phone waterfall ──
      const assigned = await db.getAssignedContact(load.assigned_team_id);
      const contacts = await db.getCarrierContacts(load.carrier_id);
      const chosen = resolvePhone({ assigned, contacts });

      if (!chosen) {
        await tracking.upsert(ref, { stage: STAGE.SKIPPED, note: 'no valid mobile', carrierId: load.carrier_id });
        results.skipped.push(ref);
        console.warn(`[WA Monitor] ${ref} — no valid mobile, skipped`);
        continue;
      }

      await tracking.upsert(ref, {
        stage: STAGE.ELIGIBLE, phone: chosen.phone, contactName: chosen.name, phoneReason: chosen.reason,
        manifestId: load.manifest_id, masterManifestId: load.master_manifest_id,
        teamId: load.assigned_team_id, carrierId: load.carrier_id, pickupAt: load.pickup_at,
      });

      // ── match HubSpot contact + send T1 ──
      const contact = await hubspot.findContact(chosen.phone);
      if (!contact) {
        await tracking.upsert(ref, { stage: STAGE.SKIPPED, note: 'no HubSpot contact for phone' });
        results.skipped.push(ref);
        continue;
      }

      await hubspot.sendPickupConfirm({ contactId: contact.id, loadRef: ref, pickupDatetime: load.pickup_at });
      await tracking.upsert(ref, { stage: STAGE.WA_SENT, hubspotContactId: String(contact.id), sentAt: new Date().toISOString() });
      await tracking.upsert(ref, { stage: STAGE.AWAITING_REPLY });

      results.sent.push(ref);
      console.log(`[WA Monitor] ${cfg.DRY_RUN ? 'DRY_RUN ' : ''}sent ${ref} → ${chosen.phone} (${chosen.reason})`);
    } catch (err) {
      console.error(`[WA Monitor] ${ref} failed:`, err.message);
      await tracking.upsert(ref, { stage: STAGE.ERROR, note: err.message });
      results.failed.push({ ref, error: err.message });
    }
  }

  console.log('[WA Monitor] done', results);
  return { statusCode: 200, body: JSON.stringify(results) };
};
