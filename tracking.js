/**
 * tracking.js — the WA state store. ISOLATED: touches no shipment data.
 * Records each shipment's journey (stage + timestamps + events) so the cron
 * never double-messages and the debug dashboard can show live progress.
 *
 * Backends:
 *   'local'  — JSON file (dev / DRY_RUN; the dashboard reads this)
 *   'dynamo' — DynamoDB (prod)  [not wired yet — see TODO]
 */
const fs = require('fs');
const cfg = require('./config');

const nowIso = () => new Date().toISOString();

// ── local JSON backend ─────────────────────────────────
function readLocal() {
  try { return JSON.parse(fs.readFileSync(cfg.TRACKING_FILE, 'utf8')); }
  catch { return {}; }
}
function writeLocal(obj) {
  fs.writeFileSync(cfg.TRACKING_FILE, JSON.stringify(obj, null, 2));
}

/** Upsert a shipment's tracking record. `patch.stage` appends a timeline event. */
async function upsert(reference, patch = {}) {
  if (cfg.TRACKING_BACKEND === 'dynamo') return upsertDynamo(reference, patch);
  const all = readLocal();
  const prev = all[reference] || { reference, events: [] };
  const next = { ...prev, ...patch, reference, updatedAt: nowIso() };
  if (patch.stage && patch.stage !== prev.stage) {
    next.events = [...(prev.events || []), { stage: patch.stage, at: nowIso(), note: patch.note || null }];
  }
  all[reference] = next;
  writeLocal(all);
  return next;
}

async function get(reference) {
  if (cfg.TRACKING_BACKEND === 'dynamo') return getDynamo(reference);
  return readLocal()[reference] || null;
}

async function all() {
  if (cfg.TRACKING_BACKEND === 'dynamo') return allDynamo();
  return Object.values(readLocal());
}

// ── dynamo backend (prod / Lambda) ─────────────────────
// Table: cfg.TRACKING_TABLE, partition key: reference (String). @aws-sdk is in the Lambda runtime.
let _doc = null;
function doc() {
  if (!_doc) {
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
    _doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.AWS_REGION }));
  }
  return _doc;
}
async function getDynamo(reference) {
  const { GetCommand } = require('@aws-sdk/lib-dynamodb');
  const r = await doc().send(new GetCommand({ TableName: cfg.TRACKING_TABLE, Key: { reference } }));
  return r.Item || null;
}
async function upsertDynamo(reference, patch = {}) {
  const prev = (await getDynamo(reference)) || { reference, events: [] };
  const next = { ...prev, ...patch, reference, updatedAt: nowIso() };
  if (patch.stage && patch.stage !== prev.stage) {
    next.events = [...(prev.events || []), { stage: patch.stage, at: nowIso(), note: patch.note || null }];
  }
  const { PutCommand } = require('@aws-sdk/lib-dynamodb');
  await doc().send(new PutCommand({ TableName: cfg.TRACKING_TABLE, Item: next }));
  return next;
}
async function allDynamo() {
  const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
  const r = await doc().send(new ScanCommand({ TableName: cfg.TRACKING_TABLE }));
  return r.Items || [];
}

// Stage constants (the state machine)
const STAGE = {
  ELIGIBLE: 'ELIGIBLE', WA_SENT: 'WA_SENT', AWAITING_REPLY: 'AWAITING_REPLY',
  ON_THE_ROAD: 'ON_THE_ROAD', FOLLOWUP_SENT: 'FOLLOWUP_SENT', AWAITING_ETA: 'AWAITING_ETA',
  ETA_RECORDED: 'ETA_RECORDED', NO_RESPONSE: 'NO_RESPONSE', SKIPPED: 'SKIPPED', ERROR: 'ERROR',
};

module.exports = { upsert, get, all, STAGE };
