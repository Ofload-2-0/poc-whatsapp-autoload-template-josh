/**
 * validate.js — READ-ONLY: run the REAL phone waterfall (phone.js) against a
 * carrier's real dev data. Prints which number it would pick, assigned vs not.
 * Sends nothing, writes nothing. Expects DATABASE_URL (set by validate-carrier.sh).
 *
 *   node validate.js "THE FREIGHT COMP PTY LTD"
 */
const { Pool } = require('pg');
const { resolvePhone, isValidAuMobile } = require('./phone');

const name = process.argv[2] || 'THE FREIGHT COMP PTY LTD';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 6000 });

const show = c => c ? `${c.phone} (${c.reason}${c.name ? ', ' + c.name : ''})` : 'NOBODY REACHABLE';

(async () => {
  // --assigned : find any load already assigned to a team member (proves Scenario A, zero setup)
  if (name.trim() === '--assigned') {
    const { rows } = await pool.query(
      `SELECT mm.id AS master_manifest_id, mm.carrier_id, co.company_name,
              (t.first_name||' '||t.last_name) AS name, t.position, t.phone
         FROM master_manifest mm
         JOIN team t     ON t.id = mm.team_id
         JOIN carrier c  ON c.id = mm.carrier_id
         JOIN company co ON co.id = c.company_id
        WHERE mm.team_id IS NOT NULL AND mm.deleted_at IS NULL AND NULLIF(t.phone,'') IS NOT NULL
        LIMIT 5`);
    if (!rows.length) { console.log('No already-assigned loads with a contactable team member found in this DB.'); await pool.end(); return; }
    console.log(`Found ${rows.length} already-assigned load(s):`);
    for (const r of rows) {
      const { rows: contacts } = await pool.query(
        `SELECT (first_name||' '||last_name) AS name, position, phone, is_primary AS "isPrimary"
           FROM team WHERE company_id = (SELECT company_id FROM carrier WHERE id=$1) AND deleted_at IS NULL`, [r.carrier_id]);
      const chosen = resolvePhone({ assigned: { name: r.name, position: r.position, phone: r.phone }, contacts });
      console.log(`\n  load(master_manifest)=${r.master_manifest_id} carrier="${r.company_name}"`);
      console.log(`    assigned member: ${r.name} | ${r.position||'-'} | ${r.phone}`);
      console.log(`    → waterfall picks: ${chosen ? `${chosen.phone} (${chosen.reason})` : 'NOBODY'}`);
    }
    await pool.end(); return;
  }

  // MANIFEST:<ref> — show the correct manifest linkage (manifest.shipment_id path vs shipment.manifest_id)
  if (name.startsWith('MANIFEST:')) {
    const ref = name.slice('MANIFEST:'.length).trim();
    const { rows: [s] } = await pool.query(`SELECT id, manifest_id, master_ship_id FROM shipment WHERE reference=$1 AND deleted_at IS NULL LIMIT 1`, [ref]);
    if (!s) { console.log('no shipment', ref); await pool.end(); return; }
    console.log(`shipment ${ref}: id=${s.id}  shipment.manifest_id=${s.manifest_id}  shipment.master_ship_id=${s.master_ship_id}`);
    const { rows } = await pool.query(
      `SELECT m.id AS manifest_id, m.master_man_id, mm.id AS master_manifest_id, mm.carrier_id, mm.team_id
         FROM manifest m JOIN master_manifest mm ON mm.id = m.master_man_id
        WHERE m.shipment_id = $1`, [s.id]);
    console.log('via manifest.shipment_id →', JSON.stringify(rows, null, 2));
    await pool.end(); return;
  }

  // EOS-CRED — find an active api_client and load its creds into .env (secret NOT printed)
  if (name.trim() === 'EOS-CRED') {
    const { rows } = await pool.query(
      `SELECT client_id, client_secret, name FROM api_clients WHERE active = true ORDER BY id LIMIT 1`);
    if (!rows.length) { console.log('No active api_client found — ask backend for a credential (Option A).'); await pool.end(); return; }
    const { client_id, client_secret, name: cname } = rows[0];
    const fs = require('fs'); const envp = require('path').join(__dirname, '.env');
    let env = ''; try { env = fs.readFileSync(envp, 'utf8'); } catch {}
    const set = (e, k, v) => { const re = new RegExp('^' + k + '=.*$', 'm'); return re.test(e) ? e.replace(re, `${k}="${v}"`) : e.trimEnd() + `\n${k}="${v}"\n`; };
    env = set(env, 'EOS_CLIENT_ID', client_id);
    env = set(env, 'EOS_CLIENT_SECRET', client_secret);
    fs.writeFileSync(envp, env);
    console.log(`✓ Loaded EOS credential for api_client "${cname}" (client_id=${client_id}) into .env. (secret not printed)`);
    await pool.end(); return;
  }

  // VERIFY:<ref> — read-only snapshot of a load's milestones / status / pickup (run before & after a write)
  if (name.startsWith('VERIFY:')) {
    const ref = name.slice('VERIFY:'.length).trim();
    const { rows: [s] } = await pool.query(`SELECT id, ship_status FROM shipment WHERE reference = $1 AND deleted_at IS NULL LIMIT 1`, [ref]);
    if (!s) { console.log(`no shipment ${ref}`); await pool.end(); return; }
    console.log(`shipment ${ref} (id=${s.id})  ship_status=${s.ship_status}`);
    const { rows: ms } = await pool.query(
      `SELECT type, actual_time, created_at FROM shipment_milestones WHERE shipment_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 12`, [s.id]);
    console.log('recent milestones:');
    ms.forEach(m => console.log(`  ${(m.type || '').padEnd(22)} actual=${m.actual_time || '—'}  created=${m.created_at}`));
    const { rows: [c] } = await pool.query(`SELECT pickup_at, actual_pick_date_from FROM cargo WHERE shipment_id = $1 ORDER BY id LIMIT 1`, [s.id]);
    console.log(`cargo: scheduled_pickup_date=${c?.pickup_at || '—'}  actual_pick_date_from=${c?.actual_pick_date_from || '—'}`);
    await pool.end(); return;
  }

  // LOOKUP:<ref> — resolve a single specific load (any state) for the panel search
  if (name.startsWith('LOOKUP:')) {
    const ref = name.slice('LOOKUP:'.length).trim();
    const { rows: [r] } = await pool.query(
      `SELECT s.reference, mf.id AS manifest_id, mm.id AS master_manifest_id,
              mm.carrier_id, co.company_name, mm.team_id,
              (t.first_name||' '||t.last_name) AS assignee, t.position, t.phone,
              EXISTS(SELECT 1 FROM shipment_milestones m WHERE m.shipment_id=s.id AND m.type='Allocated'   AND m.deleted_at IS NULL) AS allocated,
              EXISTS(SELECT 1 FROM shipment_milestones m WHERE m.shipment_id=s.id AND m.type='On The Road' AND m.deleted_at IS NULL) AS on_the_road,
              (SELECT (pickup_at + COALESCE(pick_from,'00:00:00+00'::timetz)) FROM cargo WHERE cargo.shipment_id=s.id AND pickup_at IS NOT NULL ORDER BY pickup_at LIMIT 1) AS scheduled_pickup
         FROM shipment s
         JOIN LATERAL (SELECT id, master_man_id FROM manifest WHERE shipment_id=s.id AND deleted_at IS NULL ORDER BY id DESC LIMIT 1) mf ON true
         JOIN master_manifest mm ON mm.id = mf.master_man_id
         JOIN carrier c  ON c.id = mm.carrier_id
         JOIN company co ON co.id = c.company_id
         LEFT JOIN team t ON t.id = mm.team_id
        WHERE s.reference = $1 AND s.deleted_at IS NULL LIMIT 1`, [ref]);
    if (!r) { console.log('__CANDIDATES__[]'); await pool.end(); return; }
    const contacts = (await pool.query(
      `SELECT (first_name||' '||last_name) AS name, position, phone, is_primary AS "isPrimary"
         FROM team WHERE company_id = (SELECT company_id FROM carrier WHERE id=$1) AND deleted_at IS NULL AND NULLIF(phone,'') IS NOT NULL`, [r.carrier_id])).rows;
    const chosen = resolvePhone({ assigned: r.team_id ? { name: r.assignee, position: r.position, phone: r.phone } : null, contacts });
    console.log('__CANDIDATES__' + JSON.stringify([{
      ref: r.reference, carrier: r.company_name, assignee: r.assignee || null, position: r.position || null,
      phone: chosen ? chosen.phone : null, phoneReason: chosen ? chosen.reason : 'none',
      teamId: r.team_id, manifestId: r.manifest_id, masterManifestId: r.master_manifest_id, carrierId: r.carrier_id,
      scheduledPickup: r.scheduled_pickup, allocated: r.allocated, onTheRoad: r.on_the_road,
      eligible: r.allocated && !r.on_the_road,
    }]));
    await pool.end(); return;
  }

  // CANDIDATES-JSON — machine-readable candidate loads for the control panel (resolved phone incl.)
  if (name.trim() === 'CANDIDATES-JSON') {
    const { rows } = await pool.query(
      `SELECT s.reference, mf.id AS manifest_id, mm.id AS master_manifest_id,
              mm.carrier_id, co.company_name, mm.team_id,
              (t.first_name||' '||t.last_name) AS assignee, t.position, t.phone,
              (SELECT (pickup_at + COALESCE(pick_from,'00:00:00+00'::timetz))
                 FROM cargo WHERE cargo.shipment_id=s.id AND pickup_at IS NOT NULL ORDER BY pickup_at LIMIT 1) AS scheduled_pickup
         FROM shipment s
         JOIN LATERAL (SELECT id, master_man_id FROM manifest WHERE shipment_id = s.id AND deleted_at IS NULL ORDER BY id DESC LIMIT 1) mf ON true
         JOIN master_manifest mm ON mm.id = mf.master_man_id
         JOIN carrier c  ON c.id = mm.carrier_id
         JOIN company co ON co.id = c.company_id
         LEFT JOIN team t ON t.id = mm.team_id
        WHERE s.deleted_at IS NULL
          AND EXISTS    (SELECT 1 FROM shipment_milestones m WHERE m.shipment_id=s.id AND m.type='Allocated'   AND m.deleted_at IS NULL)
          AND NOT EXISTS(SELECT 1 FROM shipment_milestones m WHERE m.shipment_id=s.id AND m.type='On The Road' AND m.deleted_at IS NULL)
        ORDER BY scheduled_pickup DESC NULLS LAST LIMIT 50`);
    const out = [];
    for (const r of rows) {
      const contacts = (await pool.query(
        `SELECT (first_name||' '||last_name) AS name, position, phone, is_primary AS "isPrimary"
           FROM team WHERE company_id = (SELECT company_id FROM carrier WHERE id=$1) AND deleted_at IS NULL AND NULLIF(phone,'') IS NOT NULL`, [r.carrier_id])).rows;
      const chosen = resolvePhone({ assigned: r.team_id ? { name: r.assignee, position: r.position, phone: r.phone } : null, contacts });
      out.push({
        ref: r.reference, carrier: r.company_name, assignee: r.assignee || null, position: r.position || null,
        phone: chosen ? chosen.phone : null, phoneReason: chosen ? chosen.reason : 'none',
        teamId: r.team_id, manifestId: r.manifest_id, masterManifestId: r.master_manifest_id, carrierId: r.carrier_id,
        scheduledPickup: r.scheduled_pickup,
      });
    }
    console.log('__CANDIDATES__' + JSON.stringify(out));
    await pool.end(); return;
  }

  // PICKUP:<carrier> — find which field actually holds the scheduled pickup time
  if (name.startsWith('PICKUP:')) {
    const term = name.slice('PICKUP:'.length).trim();
    const idish = /^\d+$/.test(term);
    const { rows: cs } = idish
      ? await pool.query(`SELECT c.id AS carrier_id, co.company_name FROM carrier c JOIN company co ON co.id=c.company_id WHERE (c.id=$1 OR co.id=$1) AND c.deleted_at IS NULL`, [term])
      : await pool.query(`SELECT c.id AS carrier_id, co.company_name FROM carrier c JOIN company co ON co.id=c.company_id WHERE (co.company_name ILIKE $1 OR co.trade_name ILIKE $1) AND c.deleted_at IS NULL LIMIT 1`, [`%${term}%`]);
    if (!cs.length) { console.log(`no carrier for "${term}"`); await pool.end(); return; }
    const cid = cs[0].carrier_id;

    console.log(`=== cargo columns that look like pickup time ===`);
    const { rows: cargoCols } = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name='cargo' AND table_schema='public'
          AND (column_name ILIKE '%pick%' OR column_name ILIKE '%time%' OR column_name ILIKE '%from%' OR column_name ILIKE '%to%' OR column_name ILIKE '%date%')
        ORDER BY ordinal_position`);
    cargoCols.forEach(c => console.log(`  cargo.${c.column_name} (${c.data_type})`));

    console.log(`\n=== "${cs[0].company_name}" shipments — scheduled pickup = cargo.pickup_at + cargo.pick_from ===`);
    const { rows } = await pool.query(
      `SELECT s.reference,
              cg.pickup_at::text                     AS pickup_date,
              cg.pick_from::text                     AS pick_time,
              (cg.pickup_at + cg.pick_from)          AS scheduled_pickup,
              cg.actual_pick_date_from               AS actual_pickup,
              ss.pick_at                             AS status_pick_at
         FROM shipment s
         JOIN master_manifest mm ON mm.id = s.master_ship_id
         LEFT JOIN shipment_status ss ON ss.id = s.ship_status_id
         LEFT JOIN LATERAL (SELECT pickup_at, pick_from, actual_pick_date_from FROM cargo WHERE cargo.shipment_id = s.id ORDER BY id LIMIT 1) cg ON true
        WHERE mm.carrier_id = $1 AND s.deleted_at IS NULL
        ORDER BY s.id DESC LIMIT 12`, [cid]);
    const ts = v => { try { return v ? new Date(v).toISOString().slice(0, 16) : '—'; } catch { return String(v); } };
    rows.forEach(r => console.log(`  ${r.reference.padEnd(14)} scheduled=${ts(r.scheduled_pickup)}  (date=${r.pickup_date || '—'} time=${r.pick_time || '—'})  actual=${ts(r.actual_pickup)}  status.pick_at=${ts(r.status_pick_at)}`));
    console.log(`\n(scheduled_pickup is what eligibility should compare against.)`);
    await pool.end(); return;
  }

  // --testable : find eligible loads (Allocated, not On The Road) that ARE assigned to a team member
  if (name.trim() === '--testable') {
    const { rows } = await pool.query(
      `SELECT s.reference, s.manifest_id, s.master_ship_id AS master_manifest_id,
              mm.carrier_id, co.company_name,
              mm.team_id, (t.first_name||' '||t.last_name) AS assignee, t.position, t.phone, ss.pick_at
         FROM shipment s
         JOIN master_manifest mm ON mm.id = s.master_ship_id
         JOIN team t     ON t.id = mm.team_id
         JOIN carrier c  ON c.id = mm.carrier_id
         JOIN company co ON co.id = c.company_id
         LEFT JOIN shipment_status ss ON ss.id = s.ship_status_id
        WHERE mm.team_id IS NOT NULL AND s.deleted_at IS NULL
          AND EXISTS    (SELECT 1 FROM shipment_milestones m WHERE m.shipment_id=s.id AND m.type='Allocated'   AND m.deleted_at IS NULL)
          AND NOT EXISTS(SELECT 1 FROM shipment_milestones m WHERE m.shipment_id=s.id AND m.type='On The Road' AND m.deleted_at IS NULL)
        ORDER BY ss.pick_at DESC NULLS LAST
        LIMIT 10`);
    if (!rows.length) { console.log('No eligible+assigned loads found.'); await pool.end(); return; }
    console.log(`Found ${rows.length} eligible + assigned load(s) — pick one to test:\n`);
    rows.forEach(r => {
      console.log(`  load ${r.reference}  (carrier "${r.company_name}")`);
      console.log(`    assigned to: ${r.assignee} | ${r.position || '-'} | current phone ${r.phone || '-'}  (team_id=${r.team_id})`);
      console.log(`    ids → manifest_id=${r.manifest_id} master_manifest_id=${r.master_manifest_id} carrier_id=${r.carrier_id}  pickAt=${r.pick_at ? new Date(r.pick_at).toISOString().slice(0,16) : '-'}\n`);
    });
    await pool.end(); return;
  }

  // ELIGIBLE:<carrier search> — show a carrier's shipments + eligibility flags (validates the query joins)
  if (name.startsWith('ELIGIBLE:')) {
    const term = name.slice('ELIGIBLE:'.length).trim();
    const idish = /^\d+$/.test(term);
    const { rows: cs } = idish
      ? await pool.query(`SELECT c.id AS carrier_id, co.company_name FROM carrier c JOIN company co ON co.id=c.company_id WHERE (c.id=$1 OR co.id=$1) AND c.deleted_at IS NULL`, [term])
      : await pool.query(`SELECT c.id AS carrier_id, co.company_name FROM carrier c JOIN company co ON co.id=c.company_id WHERE (co.company_name ILIKE $1 OR co.trade_name ILIKE $1) AND c.deleted_at IS NULL LIMIT 1`, [`%${term}%`]);
    if (!cs.length) { console.log(`no carrier for "${term}"`); await pool.end(); return; }
    const cid = cs[0].carrier_id;
    console.log(`Carrier "${cs[0].company_name}" (carrier_id=${cid}) — recent shipments + eligibility:`);
    const { rows } = await pool.query(
      `SELECT s.reference, s.manifest_id, s.master_ship_id AS master_manifest_id, ss.pick_at,
              EXISTS(SELECT 1 FROM shipment_milestones m WHERE m.shipment_id=s.id AND m.type='Allocated'    AND m.deleted_at IS NULL) AS allocated,
              EXISTS(SELECT 1 FROM shipment_milestones m WHERE m.shipment_id=s.id AND m.type='On The Road'  AND m.deleted_at IS NULL) AS on_the_road
         FROM shipment s
         JOIN master_manifest mm ON mm.id = s.master_ship_id
         LEFT JOIN shipment_status ss ON ss.id = s.ship_status_id
        WHERE mm.carrier_id = $1 AND s.deleted_at IS NULL
        ORDER BY ss.pick_at DESC NULLS LAST LIMIT 20`, [cid]);
    if (!rows.length) { console.log('  (no shipments found — check the master_ship_id join)'); await pool.end(); return; }
    const now = Date.now();
    rows.forEach(r => {
      const past = r.pick_at && new Date(r.pick_at).getTime() < now;
      const eligible = r.allocated && !r.on_the_road && past;
      console.log(`  ${r.reference.padEnd(14)} alloc=${r.allocated} onRoad=${r.on_the_road} pickAt=${r.pick_at ? new Date(r.pick_at).toISOString().slice(0,16) : '-'} ${eligible ? '  ← ELIGIBLE' : ''}`);
    });
    await pool.end(); return;
  }

  const isId = /^\d+$/.test(name.trim());
  const { rows: carriers } = isId
    ? await pool.query(
        `SELECT c.id AS carrier_id, co.id AS company_id, co.company_name, co.trade_name
           FROM carrier c JOIN company co ON co.id = c.company_id
          WHERE (c.id = $1 OR co.id = $1) AND c.deleted_at IS NULL`, [name.trim()])
    : await pool.query(
        `SELECT c.id AS carrier_id, co.id AS company_id, co.company_name, co.trade_name
           FROM carrier c JOIN company co ON co.id = c.company_id
          WHERE (co.company_name ILIKE $1 OR co.trade_name ILIKE $1) AND c.deleted_at IS NULL`, [`%${name}%`]);

  if (!carriers.length) {
    console.log(`No carrier matched "${name}". Candidate companies:`);
    const { rows: cands } = isId
      ? await pool.query(
          `SELECT co.id AS company_id, co.company_name, co.trade_name,
                  (SELECT count(*) FROM carrier c WHERE c.company_id = co.id) AS carriers,
                  (SELECT count(*) FROM team t WHERE t.company_id = co.id AND NULLIF(t.phone,'') IS NOT NULL) AS phone_contacts
             FROM company co WHERE co.id = $1`, [name.trim()])
      : await pool.query(
          `SELECT co.id AS company_id, co.company_name, co.trade_name,
                  (SELECT count(*) FROM carrier c WHERE c.company_id = co.id) AS carriers,
                  (SELECT count(*) FROM team t WHERE t.company_id = co.id AND NULLIF(t.phone,'') IS NOT NULL) AS phone_contacts
             FROM company co WHERE co.company_name ILIKE $1 OR co.trade_name ILIKE $1 LIMIT 25`, [`%${name}%`]);
    if (!cands.length) console.log('  (no companies matched either)');
    cands.forEach(c => console.log(`  company_id=${c.company_id}  carriers=${c.carriers}  phoneContacts=${c.phone_contacts}  "${c.company_name || c.trade_name}"`));
    await pool.end(); return;
  }
  console.log(`Matched carrier(s):`);
  carriers.forEach(c => console.log(`  carrier_id=${c.carrier_id} company_id=${c.company_id} "${c.company_name || c.trade_name}"`));
  const carrier = carriers[0];

  const { rows: contacts } = await pool.query(
    `SELECT (first_name||' '||last_name) AS name, position, phone, is_primary AS "isPrimary"
       FROM team WHERE company_id = $1 AND deleted_at IS NULL`, [carrier.company_id]);

  console.log(`\nTeam contacts (${contacts.length}):`);
  contacts.forEach(c => console.log(`  ${(c.name||'').padEnd(24)} ${(c.position||'-').padEnd(18)} ${(c.phone||'-').padEnd(18)} primary=${c.isPrimary} validMobile=${isValidAuMobile(c.phone)}`));

  // ── Scenario 2: NO assigned driver → waterfall over contacts ──
  console.log(`\n[Scenario B — NO assigned driver]  →  ${show(resolvePhone({ assigned: null, contacts }))}`);

  // ── Scenario 1: load assigned to a team member ──
  const { rows: mm } = await pool.query(
    `SELECT mm.id, mm.team_id FROM master_manifest mm
      WHERE mm.carrier_id = $1 AND mm.team_id IS NOT NULL AND mm.deleted_at IS NULL LIMIT 1`, [carrier.carrier_id]);
  if (mm.length) {
    const { rows: [am] } = await pool.query(
      `SELECT (first_name||' '||last_name) AS name, position, phone FROM team WHERE id = $1`, [mm[0].team_id]);
    console.log(`\n[Scenario A — load ${mm[0].id} assigned to team ${mm[0].team_id}]`);
    console.log(`  assigned = ${am ? `${am.name} | ${am.position||'-'} | ${am.phone||'-'}` : 'team not found'}`);
    console.log(`  →  ${show(resolvePhone({ assigned: am, contacts }))}`);
  } else {
    console.log(`\n[Scenario A — assigned driver]  no master_manifest with team_id for this carrier yet.`);
    console.log(`  → assign a load to a team member in the dev UI, then re-run to test this path.`);
  }
  await pool.end();
})().catch(e => { console.error('error:', e.message); process.exit(1); });
