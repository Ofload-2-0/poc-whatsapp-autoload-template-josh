/**
 * db.js — READ-ONLY queries against the EOS Ofload_site DB.
 * Used to (a) find eligible shipments and (b) resolve carrier contacts for the
 * phone waterfall. NO writes — every write-back goes through eos.js (the app API).
 *
 * ⚠️ DRAFT JOINS: the shipment→manifest linkage and the scheduled-pickup-time source
 *    are best-effort from schema inspection and MUST be validated against dev before
 *    DRY_RUN is turned off. Search "CONFIRM" below.
 */
const { Pool } = require('pg');
const cfg = require('./config');

let _pool = null;
function pool() {
  if (!_pool) {
    if (!cfg.DATABASE_URL) throw new Error('DATABASE_URL not set');
    _pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000 });
  }
  return _pool;
}

/**
 * Eligible = has an 'Allocated' milestone, NO 'On The Road' milestone,
 * scheduled pickup + TRIGGER_AFTER_MS < now, passes the fail-closed allowlist.
 */
async function getEligibleShipments() {
  const { PHASE, ENABLED_CARRIERS, ENABLED_LOADS, ALLOW_ALL, TRIGGER_AFTER_MS,
          MILESTONE_ALLOCATED, MILESTONE_ON_THE_ROAD } = cfg;

  const params = [String(TRIGGER_AFTER_MS), MILESTONE_ALLOCATED, MILESTONE_ON_THE_ROAD];
  let gate = '';
  if (PHASE === 'carrier') {
    if (!ENABLED_CARRIERS.length) { console.warn('[db] PHASE=carrier, empty allowlist → nothing'); return []; }
    params.push(ENABLED_CARRIERS); gate = `AND mm.carrier_id::text = ANY($${params.length})`;
  } else if (PHASE === 'load') {
    if (!ENABLED_LOADS.length) { console.warn('[db] PHASE=load, empty allowlist → nothing'); return []; }
    params.push(ENABLED_LOADS); gate = `AND s.reference = ANY($${params.length})`;
  } else if (PHASE === 'all') {
    if (!ALLOW_ALL) { console.warn('[db] PHASE=all but WA_ALLOW_ALL not set → nothing'); return []; }
  } else { console.warn(`[db] unknown PHASE=${PHASE} → nothing`); return []; }

  // Scheduled pickup lives on cargo: pickup_at (date) + pick_from (time). Verified in eos 2026-07-06.
  const sql = `
    SELECT s.id                 AS shipment_id,
           s.reference          AS reference,
           s.manifest_id        AS manifest_id,        -- {manifestId} for status endpoint
           s.master_ship_id     AS master_manifest_id, -- {masterManifestId} for notes/assign
           mm.carrier_id        AS carrier_id,
           mm.team_id           AS assigned_team_id,
           cg.scheduled_pickup  AS pickup_at
    FROM shipment s
    JOIN master_manifest mm ON mm.id = s.master_ship_id
    JOIN LATERAL (
      SELECT (pickup_at + COALESCE(pick_from, '00:00:00+00'::timetz)) AS scheduled_pickup
        FROM cargo WHERE cargo.shipment_id = s.id AND pickup_at IS NOT NULL
        ORDER BY pickup_at LIMIT 1
    ) cg ON true
    WHERE EXISTS (SELECT 1 FROM shipment_milestones m WHERE m.shipment_id = s.id AND m.type = $2 AND m.deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM shipment_milestones m WHERE m.shipment_id = s.id AND m.type = $3 AND m.deleted_at IS NULL)
      AND s.deleted_at IS NULL
      AND cg.scheduled_pickup + ($1 || ' milliseconds')::interval < NOW()
      ${gate}
    LIMIT 500`;
  const { rows } = await pool().query(sql, params);
  return rows;
}

/** Per-load assigned team member → {name,position,phone} | null. */
async function getAssignedContact(assignedTeamId) {
  if (!assignedTeamId) return null;
  const { rows } = await pool().query(
    `SELECT (first_name||' '||last_name) AS name, position, phone
       FROM team WHERE id = $1 AND deleted_at IS NULL LIMIT 1`, [assignedTeamId]);
  return rows[0] || null;
}

/** Carrier company contacts for the waterfall fallback (only rows with a phone). */
async function getCarrierContacts(carrierId) {
  const { rows } = await pool().query(
    `SELECT (t.first_name||' '||t.last_name) AS name, t.position, t.phone, t.is_primary AS "isPrimary"
       FROM carrier c JOIN team t ON t.company_id = c.company_id
      WHERE c.id = $1 AND t.deleted_at IS NULL AND NULLIF(t.phone,'') IS NOT NULL`, [carrierId]);
  return rows;
}

/** Match a reply back to a shipment by reference. */
async function getShipmentByReference(reference) {
  const { rows } = await pool().query(
    `SELECT s.id AS shipment_id, s.reference, s.manifest_id, s.master_ship_id AS master_manifest_id, mm.team_id AS assigned_team_id
       FROM shipment s JOIN master_manifest mm ON mm.id = s.master_ship_id
      WHERE s.reference = $1 AND s.deleted_at IS NULL LIMIT 1`, [reference]);
  return rows[0] || null;
}

module.exports = { getEligibleShipments, getAssignedContact, getCarrierContacts, getShipmentByReference };
