/**
 * pickupReplyWebhook.js — Webhook Lambda (API Gateway POST).
 *
 * HubSpot POSTs here when the carrier replies. Two reply stages:
 *   • initial reply  → "Yes" = Start Job + On The Road; "No" = send ETA follow-up
 *   • ETA reply      → add a Note (>2h ⇒ "running more than 2 hours late")
 *
 * DRY_RUN (default): classifies + logs, but performs no EOS write and sends nothing.
 */
const cfg = require('./config');
const hubspot = require('./hubspot');
const eos = require('./eos');
const tracking = require('./tracking');
const { STAGE } = tracking;

const YES_RE = /yes.*picked|picked.*up|^yes$|^y$|confirmed|on.?road|done|accept/i;
const NO_RE  = /no.*not.*picked|not.*picked|^no$|^n$|not yet|negative|decline|haven'?t|have not/i;

// NO checked before YES so "not picked up" can't be read as a confirmation.
function classifyReply(text) {
  const t = (text || '').trim();
  if (NO_RE.test(t)) return 'no';
  if (YES_RE.test(t)) return 'yes';
  return 'unrecognised';
}

// Map an ETA button/text to one of the three buckets.
function classifyEta(text) {
  const t = (text || '').trim().toLowerCase();
  if (/(>|more than|over|greater).*2|2\s*\+|later today|tomorrow/.test(t)) return '>2h';
  if (/1\s*-?\s*2|1 to 2|two hour/.test(t)) return '1-2h';
  if (/(<|less than|under|within)?.*1\s*h|1 ?hour|<\s*1|hour or less/.test(t)) return '<1h';
  return null;
}

function parsePayload(p) {
  return {
    contactId: p?.contactId || p?.object?.objectId || p?.properties?.hs_object_id,
    replyText: (p?.message?.text || p?.text || '').trim(),
    replyTime: new Date(p?.message?.createdAt || p?.occurredAt || Date.now()),
    loadRef: p?.load_reference || p?.properties?.load_reference || null,
  };
}

const toSql = d => new Date(d).toISOString().slice(0, 19).replace('T', ' ');

async function matchTracking({ loadRef, contactId }) {
  const all = await tracking.all();
  if (loadRef) { const m = all.find(t => t.reference === loadRef); if (m) return m; }
  if (contactId) return all.find(t => t.hubspotContactId === String(contactId)) || null;
  return null;
}

exports.handler = async (event) => {
  let payload;
  try { payload = typeof event.body === 'string' ? JSON.parse(event.body) : event.body; }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const { contactId, replyText, replyTime, loadRef } = parsePayload(payload);
  console.log('[WA Webhook] received', JSON.stringify({ contactId, loadRef, replyText }));
  if (!replyText) return { statusCode: 200, body: 'No text, ignored' };

  const track = await matchTracking({ loadRef, contactId });
  if (!track) { console.warn('[WA Webhook] no matching in-flight load'); return { statusCode: 200, body: 'No match' }; }
  const ref = track.reference;

  try {
    // ── ETA follow-up reply ──
    if (track.stage === STAGE.AWAITING_ETA) {
      const eta = classifyEta(replyText) || 'unspecified';
      const note = eta === '>2h'
        ? 'Driver running more than 2 hours late'
        : `Driver confirmed not yet picked up. ETA ${eta}`;
      await eos.addNote(track.masterManifestId, { text: note, severity: eta === '>2h' ? 'High' : null });
      await tracking.upsert(ref, { stage: STAGE.ETA_RECORDED, eta, note });
      console.log(`[WA Webhook] ${ref} ETA=${eta} → note recorded`);
      return { statusCode: 200, body: 'OK' };
    }

    // ── initial reply ──
    const decision = classifyReply(replyText);
    let effective = decision;
    if (decision === 'unrecognised') {
      if (cfg.UNRECOGNISED === 'ignore') { console.warn(`[WA Webhook] ${ref} unrecognised → ignore`); return { statusCode: 200, body: 'Unrecognised, ignored' }; }
      effective = 'yes';
    }

    if (effective === 'yes') {
      await eos.startJob(track.carrierId, track.manifestId, toSql(replyTime));
      await eos.onTheRoad(track.carrierId, track.manifestId, toSql(replyTime)); // R1: confirm if needed
      await tracking.upsert(ref, { stage: STAGE.ON_THE_ROAD, reply: replyText, decision: 'yes', pickupRecordedAt: replyTime.toISOString() });
      console.log(`[WA Webhook] ${ref} → On The Road`);
    } else {
      await hubspot.sendEtaFollowup({ contactId: track.hubspotContactId, loadRef: ref });
      await tracking.upsert(ref, { stage: STAGE.FOLLOWUP_SENT, reply: replyText, decision: 'no' });
      await tracking.upsert(ref, { stage: STAGE.AWAITING_ETA });
      console.log(`[WA Webhook] ${ref} → No; ETA follow-up sent`);
    }
  } catch (err) {
    console.error(`[WA Webhook] ${ref} failed:`, err.message);
    await tracking.upsert(ref, { stage: STAGE.ERROR, note: err.message });
    return { statusCode: 500, body: 'processing failed' };
  }

  return { statusCode: 200, body: 'OK' };
};

module.exports.classifyReply = classifyReply;
module.exports.classifyEta = classifyEta;
module.exports.parsePayload = parsePayload;
