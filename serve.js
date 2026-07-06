/**
 * serve.js — tiny local server for the debug dashboard (dev only).
 * Serves debug-dashboard.html and exposes /api/tracking (reads tracking.json,
 * mapped to the dashboard's row shape). No auth, localhost only.
 *
 *   npm run serve   → http://localhost:4599
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const STAGE_MAP = {
  ELIGIBLE: 'QUEUED', WA_SENT: 'SENT', AWAITING_REPLY: 'AWAIT_REPLY',
  ON_THE_ROAD: 'RECORDED', FOLLOWUP_SENT: 'AWAIT_ETA', AWAITING_ETA: 'AWAIT_ETA',
  ETA_RECORDED: 'ETA_RECORDED', NO_RESPONSE: 'ERROR', SKIPPED: 'ERROR', ERROR: 'ERROR',
};
const hhmmss = x => (x ? new Date(x).toLocaleTimeString() : null);

function rows() {
  let t = {};
  try { t = JSON.parse(fs.readFileSync(cfg.TRACKING_FILE, 'utf8')); } catch { /* no file yet */ }
  return Object.values(t).map(r => {
    const ev = Object.fromEntries((r.events || []).map(e => [e.stage, e.at]));
    return {
      ref: r.reference,
      carrier: r.contactName || (r.carrierId ? `carrier ${r.carrierId}` : '—'),
      phone: r.phone || '—',
      stage: STAGE_MAP[r.stage] || 'QUEUED',
      sent: hhmmss(r.sentAt || ev.WA_SENT),
      delivered: null,
      reply: r.reply ? { t: hhmmss(r.updatedAt), txt: r.reply, d: (r.decision || '').toUpperCase() } : null,
      recorded: r.stage === 'ON_THE_ROAD' ? hhmmss(r.updatedAt) : null,
      followup: r.eta ? { eta: r.eta } : (r.stage === 'AWAITING_ETA' ? { sent: hhmmss(ev.FOLLOWUP_SENT) } : null),
      note: r.note || (r.phoneReason ? `phone via ${r.phoneReason}` : ''),
    };
  });
}

function rawTracking() {
  try { return fs.readFileSync(cfg.TRACKING_FILE, 'utf8'); } catch { return '{}'; }
}

http.createServer((req, res) => {
  // CORS so the overlay (running on dev.app.ofload.com) can read localhost.
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url.startsWith('/api/tracking')) {           // mapped rows (dashboard)
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(rows()));
  }
  if (req.url.startsWith('/api/track')) {              // raw records keyed by ref (overlay)
    res.setHeader('content-type', 'application/json');
    return res.end(rawTracking());
  }
  if (req.url.startsWith('/wa-overlay.js')) {          // the injectable overlay script
    res.setHeader('content-type', 'application/javascript');
    return res.end(fs.readFileSync(path.join(__dirname, 'inject', 'wa-overlay.js')));
  }
  if (req.url.startsWith('/snippet')) {                // overlay + embedded data → paste into dev console
    const overlay = fs.readFileSync(path.join(__dirname, 'inject', 'wa-overlay.js'), 'utf8');
    res.setHeader('content-type', 'text/plain');
    return res.end('window.__WA_DATA__ = ' + rawTracking() + ';\n' + overlay);
  }
  res.setHeader('content-type', 'text/html');
  res.end(fs.readFileSync(path.join(__dirname, 'debug-dashboard.html')));
}).listen(4599, () => console.log('Server → http://localhost:4599  (dashboard + /wa-overlay.js)  Ctrl+C to stop'));
