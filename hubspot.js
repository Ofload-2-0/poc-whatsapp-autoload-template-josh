/**
 * hubspot.js — HubSpot: find contact by phone + trigger the two WA templates.
 * Each template is a HubSpot workflow fired via its webhook URL.
 * In DRY_RUN, lookups return a stub and triggers send nothing.
 */
const cfg = require('./config');
const HS_BASE = 'https://api-ap1.hubapi.com';
const headers = () => ({ Authorization: `Bearer ${cfg.HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' });

// Normalise a number into the variants HubSpot might store (cap 2 variants × 2 fields = 4 groups).
function phoneVariants(phone) {
  const digits = String(phone).replace(/\D/g, '');
  const v = new Set([phone]);
  if (digits.startsWith('61') && digits.length === 11) { v.add(`+${digits}`); v.add(`0${digits.slice(2)}`); }
  else if (digits.startsWith('0') && digits.length === 10) { v.add(`+61${digits.slice(1)}`); v.add(`61${digits.slice(1)}`); }
  return [...v];
}

async function findContact(phone) {
  if (cfg.DRY_RUN) { console.log(`[HubSpot][DRY_RUN] would look up contact for ${phone}`); return { id: 'DRY_RUN_CONTACT', dryRun: true }; }
  const filterGroups = phoneVariants(phone).flatMap(v => [
    { filters: [{ propertyName: 'phone', operator: 'EQ', value: v }] },
    { filters: [{ propertyName: 'mobilephone', operator: 'EQ', value: v }] },
  ]);
  const res = await fetch(`${HS_BASE}/crm/v3/objects/contacts/search`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ filterGroups, properties: ['firstname', 'lastname', 'phone', 'mobilephone'], limit: 5 }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`HubSpot contact lookup failed: ${JSON.stringify(data)}`);
  return data?.results?.[0] || null;
}

// Set the load-* contact properties the WA template renders as tokens (the POC pattern).
async function updateContact(contactId, props) {
  if (cfg.DRY_RUN) { console.log(`[HubSpot][DRY_RUN] would set contact ${contactId} props`, JSON.stringify(props)); return { dryRun: true }; }
  const res = await fetch(`${HS_BASE}/crm/v3/objects/contacts/${contactId}`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify({ properties: props }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HubSpot contact update failed (${res.status}): ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function trigger(url, payload) {
  if (cfg.DRY_RUN) { console.log(`[HubSpot][DRY_RUN] would trigger`, JSON.stringify(payload)); return { dryRun: true }; }
  if (!url) throw new Error('HubSpot webhook URL not configured');
  const res = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(payload) });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`HubSpot workflow failed (${res.status}): ${text.slice(0, 200)}`);
  return {};
}

// T1 — pickup confirmation (Yes / No buttons)
function sendPickupConfirm({ contactId, loadRef, carrierName, pickupDatetime, pickupLocation }) {
  return trigger(cfg.HUBSPOT_WEBHOOK_CONFIRM, {
    objectId: contactId, load_reference: loadRef, carrier_name: carrierName || '',
    pickup_datetime: pickupDatetime || '', pickup_location: pickupLocation || '',
  });
}

// T2 — ETA follow-up (<1h / 1–2h / >2h buttons)
function sendEtaFollowup({ contactId, loadRef }) {
  return trigger(cfg.HUBSPOT_WEBHOOK_ETA, { objectId: contactId, load_reference: loadRef });
}

module.exports = { findContact, updateContact, sendPickupConfirm, sendEtaFollowup, phoneVariants };
