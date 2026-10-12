'use strict';
/**
 * The end-to-end encryption contract, tested at both ends of it.
 *
 * The failure mode these exist to prevent is a WIRE-FORMAT MISMATCH between the
 * browser and the server. The browser produces `e1.<iv>.<ct>` and
 * `w1.<ephPub>.<salt>.<iv>.<ct>`; the server accepts exactly those shapes and
 * nothing else. When those drift, the symptom is not an error — it is a message
 * that sends fine and arrives as ciphertext, because the server validated
 * nothing and the client could not unwrap. That is the single worst thing this
 * feature can do, so the shapes are pinned here by construction: the client
 * side is exercised in the browser-side test suite, and this file pins the
 * server's half and the rules that decide which send is legal.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ENCRYPTION_VERSION,
  MAX_KEY_SHARES,
  participantForUser,
  participantForAdmin,
  isParticipant,
  isCipher,
  isWrappedKey,
  isPublicKey,
  isEncrypted,
  readMessagePayload,
  normalizeKeyShares,
  sharesForParticipant,
  encryptionView,
} = require('../utils/chatEncryption');
const { ChatInputError } = require('../utils/supportChat');

const USER_ID = '65f1c2a4b9d33e0012ab77de';
const ADMIN_ID = '65f1c2a4b9d33e0012ab77dd';

// ── Participants ─────────────────────────────────────────────────────────────

test('a participant is a role and an ObjectId, and nothing else', () => {
  assert.equal(participantForUser(USER_ID), `user:${USER_ID}`);
  assert.equal(participantForAdmin(ADMIN_ID), `admin:${ADMIN_ID}`);

  assert.equal(isParticipant(`user:${USER_ID}`), true);
  assert.equal(isParticipant(`admin:${ADMIN_ID}`), true);
  // An arbitrary string must never become a participant: this is the boundary
  // that stops a share list from naming an address the server cannot vouch for.
  assert.equal(isParticipant('nobody'), false);
  assert.equal(isParticipant('user:'), false);
  assert.equal(isParticipant('root:'.concat(USER_ID)), false);
  assert.equal(isParticipant(`user:${USER_ID}x`), false);
  assert.equal(isParticipant(''), false);
  assert.equal(isParticipant(undefined), false);
});

// ── Envelope shapes ──────────────────────────────────────────────────────────

test('a cipher envelope is e1.<iv>.<ct>', () => {
  const cipher = 'e1.' + 'A'.repeat(16) + '.' + 'A'.repeat(64);
  assert.equal(isCipher(cipher), true);
  // A 2000-character message is ~2700 bytes of UTF-8, so ~3600 base64 chars.
  assert.equal(isCipher('e1.' + 'A'.repeat(16) + '.' + 'A'.repeat(3600)), true);
  assert.equal(isCipher('e1.' + 'A'.repeat(16) + '.' + 'A'.repeat(7600)), true);
  assert.equal(isCipher('e1.' + 'A'.repeat(16) + '.' + 'A'.repeat(7601)), false);
});

test('a cipher envelope is rejected when the tag or the parts are wrong', () => {
  assert.equal(isCipher(''), false);
  assert.equal(isCipher(undefined), false);
  assert.equal(isCipher('e2.' + 'A'.repeat(16) + '.' + 'A'.repeat(32)), false);  // unknown tag
  assert.equal(isCipher('A' * 40), false);                                       // a raw body
  assert.equal(isCipher('e1.short.short'), false);                               // too short
  assert.equal(isCipher('e1.' + 'A'.repeat(16) + '.' + 'A'.repeat(15)), false);   // a byte short
  assert.equal(isCipher('e1.' + 'A'.repeat(15) + '.' + 'A'.repeat(32)), false);   // a byte short
  assert.equal(isCipher('e1.' + 'A'.repeat(16) + '.' + 'A'.repeat(16) + '.extra'), false);
  assert.equal(isCipher('.' + 'A'.repeat(16) + '.' + 'A'.repeat(16)), false);
  assert.equal(isCipher('e1..'), false);
});

test('a wrapped key is w1.<ephPub>.<salt>.<iv>.<ct>', () => {
  // 64-byte P-256 point → 86 chars; 16-byte salt → 22; 12-byte iv → 16;
  // 32+16-byte wrapped key → 64.
  const good = ['w1', 'A'.repeat(86), 'A'.repeat(22), 'A'.repeat(16), 'A'.repeat(64)].join('.');
  assert.equal(isWrappedKey(good), true);
  assert.equal(isWrappedKey(''), false);
  assert.equal(isWrappedKey(undefined), false);
  assert.equal(isWrappedKey('v1.' + 'A'.repeat(86) + '.' + 'A'.repeat(22) + '.' + 'A'.repeat(16) + '.' + 'A'.repeat(64)), false);
  assert.equal(isWrappedKey('w1.' + 'A'.repeat(86) + '.' + 'A'.repeat(22) + '.' + 'A'.repeat(16)), false);
  assert.equal(isWrappedKey('w1.' + 'A'.repeat(85) + '.' + 'A'.repeat(22) + '.' + 'A'.repeat(16) + '.' + 'A'.repeat(64)), false);
  assert.equal(isWrappedKey('w1.' + 'A'.repeat(86) + '.' + 'A'.repeat(22) + '.' + 'A'.repeat(16) + '.' + 'A'.repeat(31)), false);
});

test('a public key is a 64-byte P-256 point', () => {
  assert.equal(isPublicKey('A'.repeat(86)), true);
  // The pattern is deliberately narrow but not pedantic: it bounds the length
  // rather than requiring exactly 86. `b64uEncode` strips padding, so a padded
  // value is out of shape — and is rejected rather than trimmed. A tolerant
  // regex would accept a key mangled by a round trip somewhere and fail only at
  // the ECDH, where the failure is "cannot read" with no reason given.
  assert.equal(isPublicKey('A'.repeat(80)), true);
  assert.equal(isPublicKey('A'.repeat(64) + '='), false);
  assert.equal(isPublicKey(''), false);
  assert.equal(isPublicKey(undefined), false);
  assert.equal(isPublicKey('short'), false);
  assert.equal(isPublicKey('A'.repeat(91)), false);
  assert.equal(isPublicKey('not a key at all'), false);
});

// ── Which send is legal ─────────────────────────────────────────────────────

test('an encrypted thread accepts a ciphertext and refuses plaintext', () => {
  const thread = { encryption: { version: ENCRYPTION_VERSION } };
  const cipher = 'e1.' + 'A'.repeat(16) + '.' + 'A'.repeat(64);

  assert.deepEqual(readMessagePayload({ cipher }, thread), {
    mode: 'encrypted', body: '', cipher,
  });
  // A DELETE-worthy detail: a sealed send may ALSO carry a plaintext `body`, and
  // the server drops it. That is deliberate — an encrypted client may echo the
  // text for the server's own checks, and the mode decides what is stored.
  assert.deepEqual(
    readMessagePayload({ body: 'ignored', cipher }, thread),
    { mode: 'encrypted', body: '', cipher },
    'a plaintext body on a sealed send is stored nowhere'
  );
  // This is the rule that matters: ONE plaintext reply in the middle of a sealed
  // conversation makes "we encrypt everything" silently false.
  assert.throws(() => readMessagePayload({ body: 'hello' }, thread), ChatInputError);
  // Nothing at all is a 400, not a blank bubble that still bumps the counters.
  assert.throws(() => readMessagePayload({}, thread), ChatInputError);
  // A whitespace-only body must not slip through the same hole on this branch
  // either: on a sealed thread, `hasBody` is false so it takes the ciphertext
  // path — which is the correct behaviour, and which the plain-only case covers
  // in the next test.
});

test('a plain thread accepts text and refuses ciphertext', () => {
  // Accepting a ciphertext on a thread with no content key would store a message
  // nobody can ever read, which is indistinguishable from data loss.
  const thread = { encryption: { version: 0 } };
  assert.deepEqual(readMessagePayload({ body: ' where is my order ' }, thread), {
    mode: 'plain', body: 'where is my order', cipher: '',
  });
  assert.throws(
    () => readMessagePayload({ cipher: 'e1.' + 'A'.repeat(16) + '.' + 'A'.repeat(64) }, thread),
    ChatInputError
  );
  assert.throws(() => readMessagePayload({ body: '   ' }, thread), ChatInputError);
  assert.throws(() => readMessagePayload({}, thread), ChatInputError);
});

test('a NEW conversation decides for itself, because there is no state to inherit', () => {
  // The client that cannot encrypt sends plaintext on purpose (useSecureChat's
  // `canSealNew` is false), so a create has to accept BOTH shapes. Refusing the
  // plaintext one would mean no new conversation could ever be started on a
  // browser without WebCrypto — which is exactly the bug the e2e suite caught.
  const stub = { encryption: { version: 0 } };
  const creating = { creating: true };
  const cipher = 'e1.' + 'A'.repeat(16) + '.' + 'A'.repeat(64);

  assert.deepEqual(
    readMessagePayload({ body: ' where is my order ' }, stub, creating),
    { mode: 'plain', body: 'where is my order', cipher: '' }
  );
  assert.deepEqual(
    readMessagePayload({ body: 'ignored', cipher }, stub, creating),
    { mode: 'encrypted', body: '', cipher },
    'a sealed create may not also store its plaintext'
  );
  assert.throws(() => readMessagePayload({}, stub, creating), ChatInputError);
  assert.throws(() => readMessagePayload({ body: ' ' }, stub, creating), ChatInputError);
  assert.throws(() => readMessagePayload({ cipher: 'nope' }, stub, creating), ChatInputError);
});

test('an encrypted thread STILL refuses plaintext when `creating` is set', () => {
  // The two flags must not compose into an escape hatch. `creating` describes
  // the thread being created, not one that is already sealed.
  const thread = { encryption: { version: ENCRYPTION_VERSION } };
  assert.throws(() => readMessagePayload({ body: 'hello' }, thread, { creating: true }), ChatInputError);
});

test('a plaintext send is still held to the length cap', () => {
  const thread = { encryption: { version: 0 } };
  // 2000 characters is the cap in utils/supportChat.js; a 4 MB ENCRYPTED send
  // would decrypt to the same thing, so the cap has to be the same either way.
  assert.doesNotThrow(() => readMessagePayload({ body: 'a'.repeat(2000) }, thread));
  assert.throws(() => readMessagePayload({ body: 'a'.repeat(2001) }, thread), ChatInputError);
});

test('a bad envelope is refused before it is stored', () => {
  const thread = { encryption: { version: ENCRYPTION_VERSION } };
  assert.throws(() => readMessagePayload({ cipher: 'not-a-cipher' }, thread), ChatInputError);
  assert.throws(() => readMessagePayload({ cipher: 12345 }, thread), ChatInputError);
});

// ── Key shares ──────────────────────────────────────────────────────────────

const validWrap = ['w1', 'A'.repeat(86), 'A'.repeat(22), 'A'.repeat(16), 'A'.repeat(64)].join('.');
const anyParticipant = () => true;

test('key shares are validated and de-duplicated', () => {
  const shares = normalizeKeyShares(
    [
      { participant: `user:${USER_ID}`, wrapped: validWrap },
      { participant: `user:${USER_ID}`, wrapped: validWrap }, // duplicate
      { participant: `admin:${ADMIN_ID}`, wrapped: validWrap },
    ],
    { isAllowed: anyParticipant }
  );
  assert.equal(shares.length, 2, 'a duplicate participant is one share');
});

test('key shares are refused when the participant is not one the caller may name', () => {
  // A member may only ever name themselves and an operator. Without this, a
  // client could park a share for an arbitrary address and have it rendered back
  // as a legitimate participant.
  const onlySelf = (participant) => participant === `user:${USER_ID}`;
  assert.throws(
    () => normalizeKeyShares([{ participant: `admin:${ADMIN_ID}`, wrapped: validWrap }], { isAllowed: onlySelf }),
    ChatInputError
  );
  assert.throws(
    () => normalizeKeyShares([{ participant: 'nobody', wrapped: validWrap }], { isAllowed: anyParticipant }),
    ChatInputError
  );
  assert.throws(
    () => normalizeKeyShares([{ participant: `user:${USER_ID}`, wrapped: 'bad' }], { isAllowed: anyParticipant }),
    ChatInputError
  );
  assert.throws(() => normalizeKeyShares([], { isAllowed: anyParticipant }), ChatInputError);
  assert.throws(() => normalizeKeyShares({}, { isAllowed: anyParticipant }), ChatInputError);
  assert.throws(() => normalizeKeyShares(null, { isAllowed: anyParticipant }), ChatInputError);
});

test('the share list is bounded, so it can never become an unbounded write', () => {
  const many = Array.from({ length: MAX_KEY_SHARES + 1 }, () => ({
    participant: `admin:${ADMIN_ID}`,
    wrapped: validWrap,
  }));
  assert.throws(() => normalizeKeyShares(many, { isAllowed: anyParticipant }), ChatInputError);
});

// ── What leaves the server ──────────────────────────────────────────────────

const mkThread = (shares) => ({
  encryption: { version: ENCRYPTION_VERSION, keyShares: shares },
});

test('a caller is handed only their own wrapped key', () => {
  // The full share list is a map of who can read this conversation. A member has
  // no business reading it, and an operator has no business seeing a
  // colleague's, so the boundary is here and nowhere else.
  const thread = mkThread([
    { participant: `user:${USER_ID}`, wrapped: validWrap },
    { participant: `admin:${ADMIN_ID}`, wrapped: validWrap },
    { participant: `admin:${'65f1c2a4b9d33e0012ab77dc'}`, wrapped: validWrap },
  ]);
  const mine = sharesForParticipant(thread, `user:${USER_ID}`);
  assert.deepEqual(mine, [validWrap]);
  assert.deepEqual(sharesForParticipant(thread, `admin:${ADMIN_ID}`), [validWrap]);
  assert.deepEqual(sharesForParticipant(thread, 'admin:unknown'), []);
  assert.deepEqual(sharesForParticipant(thread, `user:${ADMIN_ID}`), []);
});

test('the public view leaks nothing but a version and a count', () => {
  const thread = mkThread([
    { participant: `user:${USER_ID}`, wrapped: validWrap },
    { participant: `admin:${ADMIN_ID}`, wrapped: validWrap },
  ]);
  assert.deepEqual(encryptionView(thread), { version: ENCRYPTION_VERSION, recipients: 2 });
  assert.deepEqual(encryptionView({ encryption: { version: 0 } }), { version: 0, recipients: 0 });
  assert.deepEqual(encryptionView({}), { version: 0, recipients: 0 });
  assert.deepEqual(encryptionView(null), { version: 0, recipients: 0 });
  assert.ok(!('keyShares' in encryptionView(thread)), 'the view must not carry shares');
});

test('version 0 is the honest "not encrypted"', () => {
  assert.equal(isEncrypted({ encryption: { version: 0 } }), false);
  assert.equal(isEncrypted({ encryption: { version: ENCRYPTION_VERSION } }), true);
  assert.equal(isEncrypted({}), false);
  assert.equal(isEncrypted(null), false);
  assert.equal(isEncrypted(undefined), false);
});
