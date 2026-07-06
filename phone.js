/**
 * phone.js — driver/contact phone resolution (the waterfall) + AU validation.
 * Pure functions, no I/O — fully unit-tested.
 *
 * Waterfall (stop at first match; only ever pick a VALID AU mobile):
 *   1. the team member assigned to the load (if set)
 *   2. else, the single valid contact on the carrier
 *   3. else (many, none assigned) by role: Director → Manager → Accounts → Driver → any
 */

// Normalise to +61… ; return null if not a recognisable AU number.
function normaliseAu(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('61') && digits.length === 11) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 10) return '+61' + digits.slice(1);
  if (digits.length === 9 && digits.startsWith('4')) return '+61' + digits; // 4xxxxxxxx
  return null;
}

// A valid WhatsApp target must be an AU MOBILE (+614 + 8 digits). Filters out
// landlines / placeholder / integration numbers.
function isValidAuMobile(phone) {
  const n = normaliseAu(phone);
  return !!n && /^\+614\d{8}$/.test(n);
}

const ROLE_PRIORITY = ['director', 'manager', 'accounts', 'driver'];
function roleRank(position) {
  const p = (position || '').toLowerCase();
  for (let i = 0; i < ROLE_PRIORITY.length; i++) {
    if (p.includes(ROLE_PRIORITY[i])) return i;
  }
  return ROLE_PRIORITY.length; // unknown role ranks last
}

function pick(c, reason) {
  return { phone: normaliseAu(c.phone), rawPhone: c.phone, name: c.name, position: c.position, reason };
}

/**
 * @param {object} opts
 *   assigned : {phone,name,position} | null   — per-load assigned team member
 *   contacts : Array<{phone,name,position,isPrimary}>  — carrier company team
 * @returns chosen {phone,name,position,reason} or null if nobody reachable
 */
function resolvePhone({ assigned, contacts = [] } = {}) {
  // 1. assigned team member
  if (assigned && isValidAuMobile(assigned.phone)) return pick(assigned, 'assigned');

  const valid = (contacts || []).filter(c => isValidAuMobile(c.phone));
  if (valid.length === 0) return null;

  // 2. single valid contact
  if (valid.length === 1) return pick(valid[0], 'single-valid');

  // 3. role priority, then primary, then any
  const sorted = valid.slice().sort((a, b) => {
    const r = roleRank(a.position) - roleRank(b.position);
    if (r !== 0) return r;
    return (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0);
  });
  const top = sorted[0];
  const reason = roleRank(top.position) < ROLE_PRIORITY.length ? `role:${top.position}` : 'any-valid';
  return pick(top, reason);
}

module.exports = { resolvePhone, isValidAuMobile, normaliseAu, roleRank };
