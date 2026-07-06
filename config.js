/**
 * config.js — central, env-driven configuration.
 * Safe defaults: DRY_RUN on, fail-closed rollout gating.
 */
const path = require('path');
const bool = (v, d = false) => (v == null ? d : /^(1|true|yes|on)$/i.test(String(v)));
const list = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);

module.exports = {
  // ── Safety ─────────────────────────────────────────────
  DRY_RUN: bool(process.env.WA_DRY_RUN, true),          // gates HubSpot SENDS
  EOS_DRY_RUN: bool(process.env.WA_EOS_DRY_RUN, true),  // gates EOS WRITE-BACKS (milestones/notes) — default OFF
                                                        // so comms can be live while write-backs stay simulated

  // ── Timing ─────────────────────────────────────────────
  TRIGGER_AFTER_MS: parseInt(process.env.TRIGGER_AFTER_MS || '7200000', 10), // 2h prod, 0 test

  // ── Rollout gating (fail-closed) ───────────────────────
  PHASE: process.env.WA_PHASE || 'carrier',      // 'load' | 'team' | 'carrier' | 'all'
  ENABLED_CARRIERS: list(process.env.WA_ENABLED_CARRIERS),
  ENABLED_TEAM: list(process.env.WA_ENABLED_TEAM),   // individual team-member ids (finest live gate)
  ENABLED_LOADS: list(process.env.WA_ENABLED_LOADS),
  ALLOW_ALL: bool(process.env.WA_ALLOW_ALL, false), // must be true for PHASE=all
  // Hard cap on sends per cron run — the blast-radius guard. Default 1 (safest).
  // Raise deliberately as you widen the rollout. Excess eligible loads are logged, not sent.
  MAX_SENDS: parseInt(process.env.WA_MAX_SENDS || '1', 10),

  // ── EOS milestone type strings (from ofload_site) ──────
  MILESTONE_ALLOCATED: process.env.WA_MS_ALLOCATED || 'Allocated',
  MILESTONE_ON_THE_ROAD: process.env.WA_MS_ON_THE_ROAD || 'On The Road',

  // ── EOS API (write-backs) ──────────────────────────────
  EOS_BASE_URL: process.env.EOS_BASE_URL || 'https://dev.app.ofload.com',
  EOS_CLIENT_ID: process.env.EOS_CLIENT_ID,       // P5 — obtain from backend/ops
  EOS_CLIENT_SECRET: process.env.EOS_CLIENT_SECRET,

  // ── HubSpot (send + reply) ─────────────────────────────
  HUBSPOT_TOKEN: process.env.HUBSPOT_TOKEN,
  HUBSPOT_WEBHOOK_CONFIRM: process.env.HUBSPOT_WEBHOOK_CONFIRM || process.env.HUBSPOT_WEBHOOK_URL,
  HUBSPOT_WEBHOOK_ETA: process.env.HUBSPOT_WEBHOOK_ETA,

  // ── Note mapping (R2 — confirm category) ───────────────
  NOTE_CATEGORY: process.env.WA_NOTE_CATEGORY || 'ETA',       // enum has no "WhatsApp"; ETA fits
  NOTE_SUB_CATEGORY: process.env.WA_NOTE_SUB_CATEGORY || null,
  NOTE_VISIBLE_TO_SHIPPER: bool(process.env.WA_NOTE_VISIBLE_TO_SHIPPER, false),

  // ── Reply handling ─────────────────────────────────────
  UNRECOGNISED: (process.env.WA_UNRECOGNISED || 'ignore').toLowerCase(), // 'ignore' | 'yes'

  // ── Tracking store (isolated — touches no shipment data) ──
  TRACKING_BACKEND: process.env.WA_TRACKING_BACKEND || 'local', // 'local' | 'dynamo'
  TRACKING_FILE: process.env.WA_TRACKING_FILE || path.join(__dirname, 'tracking.json'),
  TRACKING_TABLE: process.env.WA_TRACKING_TABLE || 'wa-pickup-tracking',
  AWS_REGION: process.env.AWS_REGION || 'ap-southeast-2',

  // ── Read-only DB (eligibility + contacts) ──────────────
  DATABASE_URL: process.env.DATABASE_URL,
};
