/**
 * Local logic tests — prove the safety-critical, pure logic WITHOUT any live DB/API.
 * Run: npm test
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { resolvePhone, isValidAuMobile, normaliseAu } = require('../phone');
const { classifyReply, classifyEta, parsePayload } = require('../pickupReplyWebhook');

// ── AU mobile validation ───────────────────────────────
test('valid AU mobiles', () => {
  for (const p of ['0420555999', '+61412345678', '0412 345 678', '61412345678', '412345678'])
    assert.ok(isValidAuMobile(p), `${p} should be valid`);
});
test('rejects non-mobiles / junk', () => {
  for (const p of ['+61 2 9555 6666', '0255556666', '', null, '123', 'accounts@x.com', '+61 20555666'])
    assert.ok(!isValidAuMobile(p), `${p} should be invalid`);
});
test('normalise to +61', () => {
  assert.strictEqual(normaliseAu('0420555999'), '+61420555999');
  assert.strictEqual(normaliseAu('+61412345678'), '+61412345678');
});

// ── Phone waterfall ────────────────────────────────────
test('1: assigned team member wins when valid', () => {
  const r = resolvePhone({
    assigned: { name: 'Driver Dan', position: 'Driver', phone: '0400111222' },
    contacts: [{ name: 'Dir', position: 'Director', phone: '0400999888', isPrimary: true }],
  });
  assert.strictEqual(r.reason, 'assigned');
  assert.strictEqual(r.phone, '+61400111222');
});
test('1→2: invalid assigned falls through to single valid contact', () => {
  const r = resolvePhone({
    assigned: { name: 'Dan', position: 'Driver', phone: '02 9555 6666' }, // landline = invalid
    contacts: [{ name: 'Only', position: 'Accounts', phone: '0400555111' }],
  });
  assert.strictEqual(r.reason, 'single-valid');
});
test('3: role priority Director > Manager > Accounts > Driver', () => {
  const contacts = [
    { name: 'D', position: 'Delivery Driver', phone: '0400000004' },
    { name: 'A', position: 'Accounts', phone: '0400000003' },
    { name: 'M', position: 'Ops Manager', phone: '0400000002' },
    { name: 'Dir', position: 'Managing Director', phone: '0400000001' },
  ];
  const r = resolvePhone({ assigned: null, contacts });
  assert.match(r.reason, /role:/);
  assert.strictEqual(r.phone, '+61400000001'); // the Director
});
test('3: with no known roles, picks a valid contact (prefers primary)', () => {
  const r = resolvePhone({ assigned: null, contacts: [
    { name: 'X', position: '', phone: '0400000009', isPrimary: false },
    { name: 'Y', position: '', phone: '0400000008', isPrimary: true },
  ]});
  assert.strictEqual(r.phone, '+61400000008');
});
test('none reachable → null', () => {
  assert.strictEqual(resolvePhone({ assigned: null, contacts: [{ phone: '02 9555 6666' }] }), null);
  assert.strictEqual(resolvePhone({ assigned: null, contacts: [] }), null);
});

// ── Reply classification ───────────────────────────────
test('YES variants', () => {
  for (const t of ['yes', 'Y', 'yes picked up', 'Picked up', 'confirmed', 'on road', 'done'])
    assert.strictEqual(classifyReply(t), 'yes', t);
});
test('NO variants (incl. the "not picked up" trap)', () => {
  for (const t of ['no', 'N', 'not yet', "haven't", 'decline', 'not picked up', 'no not picked up'])
    assert.strictEqual(classifyReply(t), 'no', t);
});
test('gibberish → unrecognised', () => {
  for (const t of ['maybe', 'call me', '???', ''])
    assert.strictEqual(classifyReply(t), 'unrecognised', t);
});

// ── ETA classification ─────────────────────────────────
test('ETA buckets', () => {
  assert.strictEqual(classifyEta('Less than 1 hour'), '<1h');
  assert.strictEqual(classifyEta('1-2 hours'), '1-2h');
  assert.strictEqual(classifyEta('More than 2 hours'), '>2h');
  assert.strictEqual(classifyEta('banana'), null);
});

// ── Payload parsing ────────────────────────────────────
test('parsePayload reads documented shape', () => {
  const { contactId, replyText } = parsePayload({ contactId: '123', message: { text: 'Yes picked up' } });
  assert.strictEqual(contactId, '123');
  assert.strictEqual(replyText, 'Yes picked up');
});
