/**
 * send-one.js <REFERENCE> — manual, single-load send of the pickup-confirmation WA.
 * Resolves the load's phone via the real waterfall, matches a HubSpot contact, sends T1.
 *
 * DRY_RUN defaults TRUE. To actually send: WA_DRY_RUN=false.
 * Needs DATABASE_URL (tunnel) + HUBSPOT_TOKEN + HUBSPOT_WEBHOOK_CONFIRM.
 */
const { Pool } = require('pg');
const cfg = require('./config');
const { resolvePhone, isAllowedRecipient } = require('./phone');
const hubspot = require('./hubspot');
const tracking = require('./tracking');
const { STAGE } = tracking;

const ref = process.argv[2];
if (!ref) { console.error('usage: node send-one.js <REFERENCE>'); process.exit(1); }
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 2, connectionTimeoutMillis: 6000 });

(async () => {
  const { rows: [load] } = await pool.query(
    `SELECT s.reference, s.manifest_id, s.master_ship_id AS master_manifest_id, mm.carrier_id, mm.team_id,
            (SELECT pick_at FROM shipment_status ss WHERE ss.id = s.ship_status_id) AS pick_at
       FROM shipment s JOIN master_manifest mm ON mm.id = s.master_ship_id
      WHERE s.reference = $1 AND s.deleted_at IS NULL LIMIT 1`, [ref]);
  if (!load) { console.error(`load not found: ${ref}`); process.exit(1); }

  const assigned = load.team_id
    ? (await pool.query(`SELECT (first_name||' '||last_name) AS name, position, phone FROM team WHERE id = $1`, [load.team_id])).rows[0]
    : null;
  const contacts = (await pool.query(
    `SELECT (first_name||' '||last_name) AS name, position, phone, is_primary AS "isPrimary"
       FROM carrier c JOIN team t ON t.company_id = c.company_id
      WHERE c.id = $1 AND t.deleted_at IS NULL AND NULLIF(t.phone,'') IS NOT NULL`, [load.carrier_id])).rows;

  const chosen = resolvePhone({ assigned, contacts });
  console.log(`load ${ref}: resolved →`, chosen);
  if (!chosen) { console.error('no valid phone — aborting'); await pool.end(); process.exit(1); }
  if (!isAllowedRecipient(chosen.phone, cfg.ALLOWED_PHONES)) {
    console.error(`recipient ${chosen.phone} not in WA_ALLOWED_PHONES — refusing to send`);
    await tracking.upsert(ref, { stage: STAGE.SKIPPED, note: 'recipient not in allowlist' });
    await pool.end(); process.exit(1);
  }

  await tracking.upsert(ref, {
    stage: STAGE.ELIGIBLE, phone: chosen.phone, contactName: chosen.name, phoneReason: chosen.reason,
    manifestId: load.manifest_id, masterManifestId: load.master_manifest_id, teamId: load.team_id, carrierId: load.carrier_id,
  });

  const contact = await hubspot.findContact(chosen.phone);
  if (!contact) {
    console.error(`no HubSpot contact for ${chosen.phone} — add a contact with this number in HubSpot, then retry`);
    await tracking.upsert(ref, { stage: STAGE.SKIPPED, note: 'no HubSpot contact' });
    await pool.end(); process.exit(1);
  }

  // Set the contact-property tokens the template renders (load_reference etc.). POC pattern.
  await hubspot.updateContact(contact.id, {
    load_reference: ref,
    load_pickup_date__time: load.pick_at || '',
    // load_pickup_location: <fetch from shipment address when we wire real pickup location>
  });

  await hubspot.sendPickupConfirm({ contactId: contact.id, loadRef: ref, pickupDatetime: load.pick_at });
  await tracking.upsert(ref, { stage: STAGE.WA_SENT, hubspotContactId: String(contact.id), sentAt: new Date().toISOString() });
  await tracking.upsert(ref, { stage: STAGE.AWAITING_REPLY });
  console.log(`${cfg.DRY_RUN ? '🟡 DRY_RUN — would send' : '✅ SENT'} pickup confirm for ${ref} → ${chosen.phone} (${chosen.reason})`);
  await pool.end();
})().catch(e => { console.error('error:', e.message); process.exit(1); });
