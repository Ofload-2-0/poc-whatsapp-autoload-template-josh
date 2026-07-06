/**
 * seed.js — seed ONE tracking record for a REAL dev load reference, so the
 * overlay matches when you open that shipment in the dev app. DRY_RUN, local only.
 *
 *   node seed.js <REFERENCE> [sent|onroad|eta1|eta2]     (default: onroad)
 */
process.env.WA_DRY_RUN = 'true';
const path = require('path');
process.env.WA_TRACKING_FILE = path.join(__dirname, 'tracking.json');
const tracking = require('./tracking');
const { STAGE } = tracking;

const ref = process.argv[2];
const scen = (process.argv[3] || 'onroad').toLowerCase();
if (!ref) { console.error('usage: node seed.js <REFERENCE> [sent|onroad|eta1|eta2]'); process.exit(1); }

(async () => {
  await tracking.upsert(ref, { stage: STAGE.ELIGIBLE, phone: '+61420555999', contactName: 'Demo Driver', phoneReason: 'assigned' });
  await tracking.upsert(ref, { stage: STAGE.WA_SENT, sentAt: new Date().toISOString(), hubspotContactId: 'DRY' });
  await tracking.upsert(ref, { stage: STAGE.AWAITING_REPLY });
  if (scen === 'onroad') {
    await tracking.upsert(ref, { stage: STAGE.ON_THE_ROAD, reply: 'Yes, picked up', decision: 'yes' });
  } else if (scen === 'eta1') {
    await tracking.upsert(ref, { stage: STAGE.FOLLOWUP_SENT, reply: 'No', decision: 'no' });
    await tracking.upsert(ref, { stage: STAGE.AWAITING_ETA });
    await tracking.upsert(ref, { stage: STAGE.ETA_RECORDED, eta: '<1h', note: 'Driver confirmed not yet picked up. ETA <1h' });
  } else if (scen === 'eta2') {
    await tracking.upsert(ref, { stage: STAGE.FOLLOWUP_SENT, reply: 'No', decision: 'no' });
    await tracking.upsert(ref, { stage: STAGE.AWAITING_ETA });
    await tracking.upsert(ref, { stage: STAGE.ETA_RECORDED, eta: '>2h', note: 'Driver running more than 2 hours late' });
  }
  console.log(`seeded ${ref} → scenario "${scen}". Re-open /snippet and re-paste to refresh the overlay.`);
})();
