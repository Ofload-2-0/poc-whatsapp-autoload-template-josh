/**
 * eos.js — EOS (ofload_site) API client for the write-backs.
 * Endpoints verified against Ofload-2-0/ofload_site (ShipmentController, ShipmentNotesController).
 *
 * ⚠️ In DRY_RUN every call LOGS its intent and performs NO HTTP request.
 * ⚠️ Some payload field names are best-effort (marked CONFIRM) — validate against
 *    a real dev call before turning DRY_RUN off. See WORKFLOW.md R1/R2.
 */
const cfg = require('./config');

let _token = null;
async function token() {
  if (cfg.DRY_RUN) return 'DRY_RUN';
  if (_token) return _token;
  const res = await fetch(`${cfg.EOS_BASE_URL}/api/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: cfg.EOS_CLIENT_ID, client_secret: cfg.EOS_CLIENT_SECRET }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`EOS auth failed (${res.status}): ${JSON.stringify(data)}`);
  _token = data?.authorisation?.token || data.access_token || data.token; // EOS returns authorisation.token
  if (!_token) throw new Error('EOS auth: no token in response');
  return _token;
}

async function call(method, path, body) {
  if (cfg.DRY_RUN || cfg.EOS_DRY_RUN) {   // write-backs stay simulated until creds + WA_EOS_DRY_RUN=false
    console.log(`[EOS][DRY_RUN] would ${method} ${path} ${body ? JSON.stringify(body) : ''}`);
    return { dryRun: true };
  }
  const res = await fetch(`${cfg.EOS_BASE_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`EOS ${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/** YES → Start Job (BeginFulfillment) + set pickup time = actualTime (ISO 'YYYY-MM-DD HH:mm:ss'). */
function startJob(teamId, manifestId, actualTime) {
  return call('POST', `/api/carrier/team/${teamId}/shipment/${manifestId}/status`,
    { status: 'is_begin', actual_time: actualTime });
}

/** Explicitly create the "On The Road" milestone. (R1 — may be implied by startJob's auto-progression.) */
function onTheRoad(teamId, manifestId, actualTime) {
  return call('POST', `/api/carrier/team/${teamId}/shipment/${manifestId}/status`,
    { milestone: cfg.MILESTONE_ON_THE_ROAD, actual_time: actualTime });
}

/** NO/ETA → add a note to the shipment (appears in the Notes tab; History follows via milestones). */
function addNote(masterManifestId, { text, category = cfg.NOTE_CATEGORY, subCategory = cfg.NOTE_SUB_CATEGORY,
                                     severity = null, visibleToShipper = cfg.NOTE_VISIBLE_TO_SHIPPER }) {
  return call('POST', `/api/admin/shipnotes`, {
    master_manifest_id: masterManifestId,          // CONFIRM: identifier field name
    note: text,
    note_category: category,
    note_sub_category: subCategory,
    visible_to_shipper: visibleToShipper,
    note_data: severity ? { severity_of_incident: severity } : undefined,
  });
}

module.exports = { startJob, onTheRoad, addNote };
