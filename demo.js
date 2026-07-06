/**
 * demo.js — populate tracking.json by exercising the REAL reply handler in DRY_RUN.
 * No DB, no network, no sends. Then: `npm run serve` and open the dashboard.
 *
 *   node demo.js
 */
process.env.WA_DRY_RUN = 'true';
process.env.WA_UNRECOGNISED = 'ignore';

const path = require('path');
const fs = require('fs');
process.env.WA_TRACKING_FILE = path.join(__dirname, 'tracking.json');

const { resolvePhone } = require('./phone');
const tracking = require('./tracking');
const { STAGE } = tracking;
const webhook = require('./pickupReplyWebhook');

fs.writeFileSync(process.env.WA_TRACKING_FILE, '{}'); // reset

// Fixtures exercise the phone waterfall + every reply branch.
const fixtures = [
  { ref: 'AUSTPUXDHAW', carrier: 251268, manifestId: 1001, masterManifestId: 5001, teamId: 9001,
    assigned: { name: 'Driver Dan', position: 'Driver', phone: '0420555999' }, contacts: [], reply: 'Yes, picked up' },
  { ref: 'AUSTEDK6VE8', carrier: 251269, manifestId: 1002, masterManifestId: 5002, teamId: 9002,
    assigned: null, contacts: [{ name: 'Carl Coaster', position: 'Director', phone: '0411222333', isPrimary: true }], reply: 'No, not yet', eta: 'Less than 1 hour' },
  { ref: 'AUSTQ9G5ABZ3', carrier: 251270, manifestId: 1003, masterManifestId: 5003, teamId: 9003,
    assigned: null, contacts: [{ name: 'Ops', position: 'Manager', phone: '0400000002' }], reply: null }, // awaiting reply
  { ref: 'AUSTLU8M4TZ', carrier: 251271, manifestId: 1004, masterManifestId: 5004, teamId: 9004,
    assigned: null, contacts: [{ name: 'Acc', position: 'Accounts', phone: '0400000003' }], reply: 'No', eta: 'More than 2 hours' },
  { ref: 'AUSTBADPHONE', carrier: 251272, manifestId: 1005, masterManifestId: 5005, teamId: 9005,
    assigned: null, contacts: [{ name: 'Landline Only', position: 'Accounts', phone: '02 9555 6666' }], reply: null }, // no valid mobile → skipped
];

(async () => {
  for (const f of fixtures) {
    const chosen = resolvePhone({ assigned: f.assigned, contacts: f.contacts });
    if (!chosen) { await tracking.upsert(f.ref, { stage: STAGE.SKIPPED, note: 'no valid mobile', carrierId: f.carrier }); continue; }

    // simulate the monitor having sent T1
    await tracking.upsert(f.ref, { stage: STAGE.ELIGIBLE, phone: chosen.phone, contactName: chosen.name, phoneReason: chosen.reason,
      manifestId: f.manifestId, masterManifestId: f.masterManifestId, teamId: f.teamId, carrierId: f.carrier });
    await tracking.upsert(f.ref, { stage: STAGE.WA_SENT, hubspotContactId: 'DRY_' + f.ref, sentAt: new Date().toISOString() });
    await tracking.upsert(f.ref, { stage: STAGE.AWAITING_REPLY });

    if (!f.reply) continue;
    // drive the REAL webhook handler (DRY_RUN) for the initial reply…
    await webhook.handler({ body: JSON.stringify({ load_reference: f.ref, message: { text: f.reply } }) });
    // …and the ETA follow-up if this branch has one
    if (f.eta) await webhook.handler({ body: JSON.stringify({ load_reference: f.ref, message: { text: f.eta } }) });
  }
  console.log('\n✅ Demo complete — tracking.json populated (all DRY_RUN, nothing sent).');
  console.log('   Now run:  npm run serve   → open http://localhost:4599');
})();
