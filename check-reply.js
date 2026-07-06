/**
 * check-reply.js <REFERENCE> — read the carrier's latest inbound WhatsApp reply from
 * HubSpot for this load's contact, then run it through the REAL reply handler
 * (classify → write-back). EOS write-back is DRY_RUN unless creds + WA_DRY_RUN=false.
 *
 * Needs HUBSPOT_TOKEN + tracking.json (from a prior send-one). No DB tunnel required.
 */
const cfg = require('./config');
const tracking = require('./tracking');
const webhook = require('./pickupReplyWebhook');

const HS_BASE = 'https://api-ap1.hubapi.com';
const headers = () => ({ Authorization: `Bearer ${cfg.HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' });

const ref = process.argv[2];
if (!ref) { console.error('usage: node check-reply.js <REFERENCE>'); process.exit(1); }

(async () => {
  const track = await tracking.get(ref);
  if (!track || !track.hubspotContactId) { console.error(`no tracked contact for ${ref} — run send-one first`); process.exit(1); }
  const contactId = track.hubspotContactId;
  console.log(`load ${ref} · contact ${contactId} · current stage ${track.stage}`);

  const tRes = await fetch(`${HS_BASE}/conversations/v3/conversations/threads?associatedContactId=${contactId}&limit=10`, { headers: headers() });
  const tData = await tRes.json();
  if (!tRes.ok) { console.error('threads fetch failed:', JSON.stringify(tData).slice(0, 200)); process.exit(1); }
  const threads = tData.results || [];
  if (!threads.length) { console.log('no conversation threads yet — reply on WhatsApp then re-run'); process.exit(0); }

  let latest = null;
  for (const th of threads) {
    const mRes = await fetch(`${HS_BASE}/conversations/v3/conversations/threads/${th.id}/messages?limit=50`, { headers: headers() });
    const mData = await mRes.json();
    for (const m of (mData.results || [])) {
      const txt = m.text || m.richText;
      if (m.direction === 'INCOMING' && txt) {
        const ts = new Date(m.createdAt).getTime();
        if (!latest || ts > latest.ts) latest = { ts, text: txt, createdAt: m.createdAt };
      }
    }
  }
  if (!latest) { console.log('no inbound reply found yet — tap a button on WhatsApp, then re-run'); process.exit(0); }
  console.log(`\n📩 latest reply: "${latest.text}"  (@ ${latest.createdAt})`);

  console.log('→ running through the reply handler…\n');
  const res = await webhook.handler({ body: JSON.stringify({ load_reference: ref, contactId, message: { text: latest.text, createdAt: latest.createdAt } }) });
  const updated = await tracking.get(ref);
  console.log(`\nhandler → ${res.statusCode} ${res.body}`);
  console.log(`tracking now: stage=${updated.stage} decision=${updated.decision || '-'} eta=${updated.eta || '-'}`);
})().catch(e => { console.error('error:', e.message); process.exit(1); });
