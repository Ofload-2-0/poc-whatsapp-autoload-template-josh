/**
 * apply-onroad.js <REFERENCE> — REAL write: authenticate to EOS and mark a load
 * Start Job + On The Road (pickup time = now). Proves the write-back actually changes dev.
 * Needs DATABASE_URL (for the manifest/team lookup) + EOS creds in .env + WA_EOS_DRY_RUN=false.
 */
const cfg = require('./config');
const { Pool } = require('pg');
const eos = require('./eos');

const ref = process.argv[2];
if (!ref) { console.error('usage: node apply-onroad.js <REFERENCE>'); process.exit(1); }
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 2, connectionTimeoutMillis: 6000 });

(async () => {
  // Use the manifest→master path (what the API's manifestBelongsToCarrier scope uses).
  const { rows: [l] } = await pool.query(
    `SELECT m.id AS manifest_id, mm.carrier_id, mm.team_id
       FROM shipment s
       JOIN manifest m ON m.shipment_id = s.id
       JOIN master_manifest mm ON mm.id = m.master_man_id
      WHERE s.reference = $1 AND s.deleted_at IS NULL LIMIT 1`, [ref]);
  if (!l) { console.error(`load not found: ${ref}`); await pool.end(); process.exit(1); }

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  console.log(`Applying On The Road to ${ref} — carrier=${l.carrier_id} manifest=${l.manifest_id} at ${now}`);
  console.log(`  DRY_RUN=${cfg.DRY_RUN} EOS_DRY_RUN=${cfg.EOS_DRY_RUN} (both must be false for a real write)\n`);

  console.log('startJob  →', JSON.stringify(await eos.startJob(l.carrier_id, l.manifest_id, now)));
  console.log('onTheRoad →', JSON.stringify(await eos.onTheRoad(l.carrier_id, l.manifest_id, now)));
  console.log('\nDone. Re-run VERIFY to confirm the milestone/status changed.');
  await pool.end();
})().catch(e => { console.error('error:', e.message); process.exit(1); });
