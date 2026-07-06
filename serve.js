/**
 * serve.js — LOCAL control panel server (dev testing only).
 * Binds to 127.0.0.1 → only visible on your machine (private). No auth by design.
 *
 *   npm run serve   → http://localhost:4599
 *
 * Serves the control panel and drives the existing scripts behind buttons:
 *   GET  /api/tracking    live state (tracking.json)
 *   GET  /api/candidates  eligible loads from dev (read-only), with resolved phone
 *   POST /api/send        { refs:[], mode, allowedPhones }  → send-one.sh per ref
 *   POST /api/check       { refs:[], mode }                 → check-reply.sh per ref
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const cfg = require('./config');

const HERE = __dirname;
const hhmm = x => { try { return x ? new Date(x).toLocaleTimeString() : null; } catch { return null; } };

// ── tracking → dashboard rows ──
const STAGE_MAP = {
  ELIGIBLE: 'QUEUED', WA_SENT: 'SENT', AWAITING_REPLY: 'AWAIT_REPLY', ON_THE_ROAD: 'RECORDED',
  FOLLOWUP_SENT: 'AWAIT_ETA', AWAITING_ETA: 'AWAIT_ETA', ETA_RECORDED: 'ETA_RECORDED',
  NO_RESPONSE: 'ERROR', SKIPPED: 'ERROR', ERROR: 'ERROR',
};
function trackingRows() {
  let t = {};
  try { t = JSON.parse(fs.readFileSync(cfg.TRACKING_FILE, 'utf8')); } catch { /* none */ }
  return Object.values(t).map(r => ({
    ref: r.reference, carrier: r.contactName || (r.carrierId ? `carrier ${r.carrierId}` : '—'),
    phone: r.phone || '—', stage: STAGE_MAP[r.stage] || 'QUEUED', rawStage: r.stage,
    sent: hhmm(r.sentAt), reply: r.reply || null, decision: r.decision || null, eta: r.eta || null,
    note: r.note || (r.phoneReason ? `phone via ${r.phoneReason}` : ''), updatedAt: r.updatedAt,
  }));
}

// ── run a script, return {code, out} ──
function run(script, args, extraEnv, cb) {
  execFile('bash', [path.join(HERE, script), ...args],
    { cwd: HERE, env: { ...process.env, DB: 'eos', ...extraEnv }, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout, stderr) => cb({ code: err ? (err.code || 1) : 0, out: (stdout || '') + (stderr || '') }));
}

function body(req) {
  return new Promise(res => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch { res({}); } }); });
}
const json = (res, obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/api/tracking') return json(res, trackingRows());

  if (url === '/api/candidates') {
    return run('validate-carrier.sh', ['CANDIDATES-JSON'], {}, r => {
      const line = r.out.split('\n').find(l => l.startsWith('__CANDIDATES__'));
      if (!line) return json(res, { error: 'no candidates', log: r.out.slice(-800) }, 500);
      try { return json(res, { candidates: JSON.parse(line.replace('__CANDIDATES__', '')) }); }
      catch (e) { return json(res, { error: e.message, log: r.out.slice(-800) }, 500); }
    });
  }

  if (url === '/api/send' && req.method === 'POST') {
    const { refs = [], mode = 'dry', allowedPhones = '' } = await body(req);
    const env = { WA_ALLOWED_PHONES: allowedPhones };
    const arg = mode === 'dry' ? [] : ['live'];   // send-one only sends (no EOS write)
    const results = [];
    for (const ref of refs) {
      await new Promise(done => run('send-one.sh', [ref, ...arg], env, r => { results.push({ ref, ...r }); done(); }));
    }
    return json(res, { results });
  }

  if (url === '/api/check' && req.method === 'POST') {
    const { refs = [], mode = 'live' } = await body(req);
    const results = [];
    for (const ref of refs) {
      await new Promise(done => run('check-reply.sh', [ref, mode], {}, r => { results.push({ ref, ...r }); done(); }));
    }
    return json(res, { results });
  }

  if (url === '/wa-overlay.js') { res.setHeader('content-type', 'application/javascript'); return res.end(fs.readFileSync(path.join(HERE, 'inject', 'wa-overlay.js'))); }

  // default: the control panel
  res.setHeader('content-type', 'text/html');
  res.end(fs.readFileSync(path.join(HERE, 'control-panel.html')));
});

server.listen(4599, '127.0.0.1', () => console.log('🕹  Control panel (private) → http://localhost:4599   Ctrl+C to stop'));
