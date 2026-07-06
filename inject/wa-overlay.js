/**
 * wa-overlay.js — READ-ONLY demo overlay for the dev app.
 * Injected into a dev shipment page; shows the WA pickup status, a History-style
 * timeline, and the Note — fed from our LOCAL tracking store (localhost:4599).
 *
 * It sends nothing and writes nothing. It only reads localhost + reads the page's
 * load reference. Clearly labelled as a demo overlay (not real dev data).
 *
 * Load via the bookmarklet (see INJECT.md) or paste this into the dev-tools console.
 */
(function () {
  const API = (window.__WA_API__ || 'http://localhost:4599') + '/api/track';
  const REF_RE = /AUS[HT][A-Z0-9]{6,}/;   // Ofload load reference pattern

  function detectRef() {
    const fromUrl = location.href.match(REF_RE);
    if (fromUrl) return fromUrl[0];
    const fromText = (document.body.innerText || '').match(REF_RE);
    return fromText ? fromText[0] : null;
  }

  const STAGE = {
    ELIGIBLE:       ['#eef2ff', '#3730a3', 'Queued'],
    WA_SENT:        ['#dbeafe', '#1e40af', 'Pickup check sent'],
    AWAITING_REPLY: ['#fef3c7', '#92400e', 'Awaiting reply'],
    ON_THE_ROAD:    ['#dcfce7', '#166534', 'On The Road ✔'],
    FOLLOWUP_SENT:  ['#f3e8ff', '#6b21a8', 'ETA follow-up sent'],
    AWAITING_ETA:   ['#f3e8ff', '#6b21a8', 'Awaiting ETA'],
    ETA_RECORDED:   ['#dcfce7', '#166534', 'ETA recorded ✔'],
    SKIPPED:        ['#fee2e2', '#991b1b', 'Skipped'],
    ERROR:          ['#fee2e2', '#991b1b', 'Error'],
  };
  const EVENT_LABEL = {
    ELIGIBLE: 'Eligible for pickup check', WA_SENT: 'Pickup check sent to WhatsApp',
    AWAITING_REPLY: 'Awaiting reply', ON_THE_ROAD: 'Start job — load On The Road',
    FOLLOWUP_SENT: 'ETA follow-up sent', AWAITING_ETA: 'Awaiting ETA', ETA_RECORDED: 'ETA recorded',
    SKIPPED: 'Skipped — no valid mobile',
  };

  let panel = document.getElementById('wa-pickup-panel');
  if (!panel) { panel = document.createElement('div'); panel.id = 'wa-pickup-panel'; document.body.appendChild(panel); }
  panel.style.cssText = 'position:fixed;bottom:20px;right:20px;width:370px;z-index:2147483647;' +
    'font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#fff;border:1px solid #e2e6ee;' +
    'border-radius:12px;box-shadow:0 12px 44px rgba(0,0,0,.20);overflow:hidden';

  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const hhmm = x => { try { return new Date(x).toLocaleTimeString(); } catch { return ''; } };

  async function render() {
    const ref = detectRef();
    let data = {};
    let reachable = true;
    if (window.__WA_DATA__) {
      data = window.__WA_DATA__;                 // embedded (console snippet — no network, HTTPS-safe)
    } else {
      try { data = await (await fetch(API, { cache: 'no-store' })).json(); } // same-origin dashboard use
      catch (e) { reachable = false; }
    }

    let rec = ref && data[ref] ? data[ref] : null;
    let sample = false;
    if (!rec) { const vals = Object.values(data); if (vals.length) { rec = vals[0]; sample = true; } } // demo fallback

    const badge = rec ? (STAGE[rec.stage] || ['#eef2ff', '#333', rec.stage]) : ['#f1f5f9', '#64748b', 'No WhatsApp activity'];
    const events = (rec && rec.events) || [];
    const timeline = events.map(e =>
      `<div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid #f1f5f9">
         <span>${esc(EVENT_LABEL[e.stage] || e.stage)}</span>
         <span style="color:#94a3b8;white-space:nowrap">System · WhatsApp · ${hhmm(e.at)}</span></div>`).join('');
    const note = rec && rec.note
      ? `<div style="margin-top:10px;padding:10px;background:#f8fafc;border:1px solid #eef2f7;border-radius:8px">
           <b>WhatsApp | Late Pickup</b><br><span style="color:#475569">${esc(rec.note)}</span></div>` : '';

    panel.innerHTML =
      `<div style="padding:11px 14px;background:#0f1420;color:#fff;display:flex;justify-content:space-between;align-items:center">
         <b>📦 WA Pickup</b>
         <span style="opacity:.7;font-size:11px">${esc(ref || 'no load ref on page')}</span>
       </div>
       <div style="padding:14px">
         <span style="display:inline-block;padding:3px 11px;border-radius:20px;font-weight:600;background:${badge[0]};color:${badge[1]}">${esc(badge[2])}</span>
         ${sample ? '<span style="margin-left:8px;font-size:11px;color:#b45309">sample (no match for this load)</span>' : ''}
         ${rec ? `<div style="margin-top:9px;color:#475569">Contact: <b>${esc(rec.contactName || '-')}</b> · ${esc(rec.phone || '-')}
                    ${rec.phoneReason ? `<span style="font-size:11px;color:#94a3b8">(${esc(rec.phoneReason)})</span>` : ''}</div>` : ''}
         ${rec && rec.eta ? `<div style="margin-top:3px">ETA: <b>${esc(rec.eta)}</b></div>` : ''}
         <div style="margin-top:12px;font-size:11px;text-transform:uppercase;color:#94a3b8;letter-spacing:.04em">Transaction history</div>
         ${timeline || '<div style="color:#94a3b8;padding:6px 0">No events yet</div>'}
         ${note}
         <div style="margin-top:11px;font-size:11px;color:#cbd5e1">
           ${reachable ? '' : '⚠ localhost:4599 not reachable — run <code>npm run serve</code>. '}
           read-only demo overlay · DRY_RUN · not written to dev
         </div>
       </div>`;
  }

  render();
  clearInterval(window.__waTimer__);
  window.__waTimer__ = setInterval(render, 5000);
  console.log('[WA overlay] loaded (read-only). Reading', API);
})();
