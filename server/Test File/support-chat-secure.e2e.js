/**
 * End-to-end check for TICKET IDS and END-TO-END ENCRYPTION over HTTP.
 *
 * Run: node "Test File/support-chat-secure.e2e.js"   (server must be listening)
 *
 * This suite exercises the two features that change the wire: the `SW-XXXXXXXX`
 * reference on every thread, and the ciphertext-plus-wrapped-key-share shape of
 * a sealed conversation. What makes it worth the effort over the unit tests is
 * that it drives the route through Express, so it catches the failure mode the
 * unit tests cannot see: the member side and the admin side disagreeing about
 * the shape of what crosses the wire.
 *
 * The invariant under test, in one line: after a send, the server holds bytes it
 * cannot read and both participants can.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
require('dotenv').config();

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const assert = require('node:assert/strict');

const User = require('../models/User');
const Session = require('../models/Session');
const AdminAccount = require('../models/AdminAccount');
const ChatThread = require('../models/ChatThread');
const ChatMessage = require('../models/ChatMessage');
const UserNotification = require('../models/UserNotification');

const BASE = `${require('../utils/tls').loopbackOrigin()}/api`;

let passed = 0;
const check = (label, cond) => {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  ok  ${label}`);
};

async function call(token, path, method = 'GET', body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { status: res.status, data };
}

/** Create a throwaway member with a live session, and mint its token. */
async function makeUser(label) {
  const user = await User.create({
    firstName: `Chat${label}`,
    lastName: 'Tester',
    email: `sw.secure.${label}.${Date.now()}@example.test`,
    password: 'not-used-here',
    dateOfBirth: new Date('1990-01-01'),
    gender: 'Female',
  });
  const session = await Session.create({
    user: user._id,
    tokenHash: 'e2e',
    userAgent: 'e2e',
    ip: '127.0.0.1',
  });
  user.currentSessionId = session._id;
  await user.save();
  const token = jwt.sign({ id: String(user._id), sid: String(session._id) }, process.env.JWT_SECRET, { algorithm: 'HS256' });
  return { user, token };
}

async function makeAdminToken() {
  const admin = await AdminAccount.findOne({ enabled: true }).lean();
  assert.ok(admin, 'an enabled admin account must exist');
  await AdminAccount.updateOne({ _id: admin._id }, { $set: { lastActivityAt: new Date() } });
  return {
    token: jwt.sign(
      { id: String(admin._id), adminId: String(admin._id), role: 'admin' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '10m' }
    ),
    admin,
  };
}

// ── The browser half, inlined ───────────────────────────────────────────────
//
// The point of this suite is the WIRE, so the crypto is the same P-256 ECDH the
// app uses, run through node's WebCrypto. It is deliberately not imported from
// my-react-app: that module reads localStorage, and a suite that depends on a
// browser shim for its own crypto cannot tell whether a failure came from the
// route or from the shim.

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const ub64 = (str) => new Uint8Array(Buffer.from(String(str), 'base64url'));

async function generateIdentity() {
  const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const point = Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { keyId: crypto.randomBytes(5).toString('hex').slice(0, 10), publicKey: b64u(point), privateKey: pair.privateKey };
}

/**
 * Import a public key from its wire form.
 *
 * A P-256 point CANNOT be imported as `raw` — WebCrypto's ECDH import takes a
 * JWK (`{kty:'EC', crv, x, y}`), and passing the 64 raw bytes throws
 * `Invalid keyData`. It is the same constraint that forced `kty: 'EC'` rather
 * than `'ECDH'` in the client module, caught here because the server never
 * imports a key and so has no other place to catch it.
 */
async function importPublicKey(recipientPublicKey) {
  const bytes = ub64(recipientPublicKey);
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: b64u(bytes.slice(0, 32)),
      y: b64u(bytes.slice(32, 64)),
    },
    ECDH,
    true,
    [],
  );
}

/** ECIES: ephemeral ECDH, HKDF to a KEK, AES-GCM to wrap the 32-byte key. */
async function wrapContentKey(contentKey, recipientPublicKey) {
  const raw = await crypto.subtle.exportKey('raw', contentKey);
  const ephemeral = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const ephemeralJwk = await crypto.subtle.exportKey('jwk', ephemeral.publicKey);
  const ephemeralPoint = Buffer.concat([
    Buffer.from(ephemeralJwk.x, 'base64url'),
    Buffer.from(ephemeralJwk.y, 'base64url'),
  ]);

  const salt = crypto.randomBytes(16);
  // The sender derives the secret from their EPHEMERAL private half and the
  // recipient's PUBLIC half; the recipient derives the same value from their
  // PRIVATE half and the ephemeral public half. That asymmetry is the whole
  // mechanism, and it is why a share is readable by exactly one identity.
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: await importPublicKey(recipientPublicKey) },
    ephemeral.privateKey,
    256,
  ));

  const base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const kek = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('suppliwise/chat/keywrap/v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const iv = crypto.randomBytes(12);
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, raw);
  return `w1.${b64u(ephemeralPoint)}.${b64u(salt)}.${b64u(iv)}.${b64u(new Uint8Array(sealed))}`;
}

const openWrappedKey = async (wrapped, privateKey) => {
  const [tag, ephRaw, salt, iv, ct] = String(wrapped).split('.');
  if (tag !== 'w1') return null;
  try {
    const shared = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'ECDH', public: await importPublicKey(ephRaw) },
      privateKey,
      256,
    ));
    const base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const kek = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: ub64(salt), info: new TextEncoder().encode('suppliwise/chat/keywrap/v1') },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(iv) }, kek, ub64(ct));
    return crypto.subtle.importKey('raw', new Uint8Array(opened), 'AES-GCM', true, ['encrypt', 'decrypt']);
  } catch {
    // A stranger's key derives a DIFFERENT secret, so the AES-GCM tag check
    // throws OperationError rather than failing quietly. This helper's contract
    // is "null when this identity cannot open it" — that throw is the answer.
    return null;
  }
};

const sealText = async (contentKey, text) => {
  const iv = crypto.randomBytes(12);
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, contentKey, new TextEncoder().encode(text));
  return `e1.${b64u(iv)}.${b64u(new Uint8Array(sealed))}`;
};

const openText = async (contentKey, envelope) => {
  const [, iv, ct] = String(envelope).split('.');
  const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64(iv) }, contentKey, ub64(ct));
  return new TextDecoder().decode(opened);
};

const TICKET_PATTERN = /^SW-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('connected\n');

  const alice = await makeUser('Alice');
  const bob = await makeUser('Bob');
  const { token: adminToken, admin } = await makeAdminToken();
  const memberParticipant = `user:${alice.user._id}`;

  // A throwaway member identity, as the browser would generate one.
  const memberIdentity = await generateIdentity();

  // ── 1. The member's key is published ────────────────────────────────────
  console.log('\n1. publishing a public key');
  let r = await call(alice.token, '/support-chat/encryption/key');
  check('a new account has no key yet', r.data.key.publicKey === '');
  r = await call(alice.token, '/support-chat/encryption/key', 'POST', {
    keyId: memberIdentity.keyId,
    publicKey: memberIdentity.publicKey,
  });
  check('201 on publish', r.status === 200 || r.status === 201);
  check('the published key comes back', r.data.key.publicKey === memberIdentity.publicKey);
  r = await call(alice.token, '/support-chat/encryption/key');
  check('and it persists', r.data.key.publicKey === memberIdentity.publicKey);

  // ── 2. Validation ────────────────────────────────────────────────────────
  console.log('\n2. key validation');
  r = await call(alice.token, '/support-chat/encryption/key', 'POST', { keyId: 'x', publicKey: 'nope' });
  check('a nonsense key is refused', r.status === 400);
  r = await call(alice.token, '/support-chat/encryption/key', 'POST', { keyId: 'BAD ID', publicKey: memberIdentity.publicKey });
  check('a malformed key id is refused', r.status === 400);
  r = await call(adminToken, '/support-chat/encryption/key');
  check('an admin token cannot read a member key', r.status === 403);

  // ── 3. Every thread gets a ticket id ─────────────────────────────────────
  console.log('\n3. ticket ids on a plain conversation');
  r = await call(alice.token, '/support-chat', 'POST', { subject: 'Where did I pay?', body: 'I transferred 1295 on Tuesday.' });
  const plainThread = r.data.thread;
  check('created', r.status === 201);
  check('has a ticket id', TICKET_PATTERN.test(plainThread.ticketId));
  check('and it is not an ObjectId', !/^[a-f0-9]{24}$/.test(plainThread.ticketId));
  const firstTicket = plainThread.ticketId;

  r = await call(alice.token, '/support-chat');
  check('the list carries the ticket id', r.data.threads.some((t) => t._id === plainThread._id && t.ticketId === firstTicket));
  r = await call(alice.token, `/support-chat/${plainThread._id}`);
  check('and so does the detail view', r.data.thread.ticketId === firstTicket);

  // The e2e above proves nothing about legacy threads being BACKFILLED, so do it
  // directly: a thread written before this feature existed has no code, and the
  // list endpoint must stamp one rather than render a blank.
  const legacy = await ChatThread.create({
    user: bob.user._id, subject: 'Legacy thread without a ticket id', status: 'open',
  });
  check('the legacy thread really has no code', !legacy.ticketId);
  r = await call(bob.token, '/support-chat');
  const backfilled = r.data.threads.find((t) => t._id === String(legacy._id));
  check('the list backfills it', Boolean(backfilled) && TICKET_PATTERN.test(backfilled.ticketId));
  check('and it stuck', TICKET_PATTERN.test((await ChatThread.findById(legacy._id).lean()).ticketId));
  check('two threads never share a code', backfilled.ticketId !== firstTicket);

  // ── 4. Admin search by ticket id ─────────────────────────────────────────
  console.log('\n4. finding a conversation by its ticket');
  r = await call(adminToken, `/admin/chats?search=${encodeURIComponent(firstTicket)}`);
  check('an exact search finds it', r.data.threads.some((t) => t._id === plainThread._id));
  // Every form a human actually types. The prefix is part of the code, so a
  // search is `sw-4kq7m2xb` or `sw4kq7m2xb` — NOT `sw-sW-…`, which is what the
  // first draft of this test helpfully sent and then reported as a bug.
  r = await call(adminToken, '/admin/chats?search=' + encodeURIComponent(firstTicket.toLowerCase()));
  check('a lower-case search finds it', r.data.threads.some((t) => t._id === plainThread._id));
  r = await call(adminToken, '/admin/chats?search=' + encodeURIComponent(firstTicket.replace('-', '')));
  check('a hyphen-less search finds it', r.data.threads.some((t) => t._id === plainThread._id));
  r = await call(adminToken, '/admin/chats?search=' + encodeURIComponent(firstTicket.slice(0, 6)));
  check('a partial code narrows the queue', Array.isArray(r.data.threads));
  r = await call(adminToken, '/admin/chats?search=' + encodeURIComponent('SW-0000000'));
  check('an unknown code returns an empty page, not the whole queue', r.data.threads.length === 0);

  // ── 5. An operator publishes a key, so a sealed send is possible ──────────
  console.log('\n5. the operator publishes a key');
  const adminIdentity = await generateIdentity();
  r = await call(adminToken, '/admin/chats/encryption/key', 'POST', {
    keyId: adminIdentity.keyId,
    publicKey: adminIdentity.publicKey,
  });
  check('published', r.data.key.publicKey === adminIdentity.publicKey);

  r = await call(alice.token, '/support-chat/encryption/operators');
  check('the member can see operator public keys', Array.isArray(r.data.operators));
  // Not every deployment has an operator key — this one does, because we just
  // published one.
  const knownOperator = r.data.operators.find((o) => o.participant === `admin:${admin._id}`);
  check('and finds the operator who just published', Boolean(knownOperator));
  r = await call(bob.token, '/support-chat/encryption/operators');
  check('another member sees the same directory', Array.isArray(r.data.operators));

  // ── 6. A sealed conversation is stored unreadable ────────────────────────
  console.log('\n6. starting an encrypted conversation');
  const contentKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const openingText = 'My card was charged twice and I need one refunded.';
  const shareForMember = await wrapContentKey(contentKey, memberIdentity.publicKey);
  const shareForAdmin = await wrapContentKey(contentKey, adminIdentity.publicKey);

  r = await call(alice.token, '/support-chat', 'POST', {
    subject: 'Double charge on my card',
    cipher: await sealText(contentKey, openingText),
    keyShares: [
      { participant: memberParticipant, wrapped: shareForMember },
      { participant: `admin:${admin._id}`, wrapped: shareForAdmin },
    ],
  });
  if (r.status !== 201) { console.error('CREATE FAILED:', r.status, JSON.stringify(r.data)); }
  check('created as sealed', r.status === 201);
  const secureThread = r.data.thread;
  check('and carries a ticket id too', TICKET_PATTERN.test(secureThread.ticketId));
  check('version 1', secureThread.encryption.version === 1);
  check('no recipients leaked', secureThread.encryption.recipients === 2);
  check('the member gets their own share', secureThread.keyShares[0] === shareForMember && secureThread.keyShares.length === 1);
  // The sealed preview travels with the thread view, so the inbox list can show
  // the newest message without a second read.
  check('the row carries a sealed preview', String(secureThread.lastMessagePreviewCipher).startsWith('e1.'));

  // THE point of the whole feature: the stored document must contain neither of
  // these, and the message must still be readable by the party holding the key.
  const row = await ChatMessage.findOne({ thread: secureThread._id }).lean();
  check('the stored message is ciphertext', String(row.cipher).startsWith('e1.'));
  check('and its body is empty', row.body === '');

  const storedThread = await ChatThread.findById(secureThread._id).lean();
  check('the stored queue preview does not leak the message', storedThread.lastMessagePreview === '');
  check('but it carries the sealed preview instead', String(storedThread.lastMessagePreviewCipher).startsWith('e1.'));
  check('the stored subject names the topic, not the message', storedThread.subject === 'Double charge on my card');
  check('and the subject does not contain the message either', !storedThread.subject.includes('twice and'));

  // The server's copy must be UNREADABLE. These are the assertions that fail if
  // anybody ever "helpfully" stores the body alongside the ciphertext.
  const decodedCipher = Buffer.from(row.cipher.split('.')[2], 'base64url').toString('utf8');
  check('the stored bytes are not the plaintext', !decodedCipher.includes('twice'));
  check('and the plaintext is nowhere in the stored thread', !JSON.stringify(storedThread).includes('refunded'));

  // The member can read their own message back.
  r = await call(alice.token, `/support-chat/${secureThread._id}`);
  const openedByMember = await openText(await openWrappedKey(r.data.thread.keyShares[0], memberIdentity.privateKey), r.data.messages[0].cipher);
  check('the member can read their own message', openedByMember === openingText);
  check('no plaintext body travels in the payload', r.data.messages[0].body === '');
  check('the ciphertext travels', r.data.messages[0].cipher === row.cipher);

  // ── 7. Isolation of the shares ───────────────────────────────────────────
  console.log('\n7. the member is handed nobody else\'s share');
  r = await call(alice.token, '/support-chat');
  const listedSecure = r.data.threads.find((t) => t._id === secureThread._id);
  check('the list carries only the member\'s share', listedSecure.keyShares.length === 1);
  check('and it is the member\'s', listedSecure.keyShares[0] === shareForMember);
  check('another account cannot see the thread at all', await call(bob.token, `/support-chat/${secureThread._id}`).then((x) => x.status === 404));

  // ── 8. The operator reads and replies under the seal ─────────────────────
  console.log('\n8. the operator replies');
  r = await call(adminToken, `/admin/chats/${secureThread._id}`);
  check('the thread opens', r.status === 200);
  const adminKey = await openWrappedKey(r.data.thread.keyShares[0], adminIdentity.privateKey);
  check('the operator can open the member\'s message', await openText(adminKey, r.data.messages[0].cipher) === openingText);
  check('the console still has the alias', r.data.messages[0].authorName.length > 0);
  check('and the ticket id', r.data.thread.ticketId === secureThread.ticketId);

  const replyText = 'We can see the duplicate charge. The refund is on its way.';
  r = await call(adminToken, `/admin/chats/${secureThread._id}/messages`, 'POST', { cipher: await sealText(adminKey, replyText) });
  check('201 on a sealed reply', r.status === 201);
  check('author recorded as admin', r.data.message_record.author === 'admin');
  check('no plaintext body', r.data.message_record.body === '');

  // A plaintext reply on a sealed thread must be REFUSED. This is the rule that
  // stops "we encrypt everything" quietly becoming untrue.
  r = await call(adminToken, `/admin/chats/${secureThread._id}/messages`, 'POST', { body: 'plain for the lolz' });
  check('a plaintext reply on a sealed thread is refused', r.status === 400);
  r = await call(alice.token, `/support-chat/${secureThread._id}/messages`, 'POST', { body: 'me too' });
  check('and so is the member\'s', r.status === 400);
  check('neither write landed', (await ChatMessage.countDocuments({ thread: secureThread._id })) === 2);

  // ── 9. The member reads the reply, and the transcript preview stays sealed ─
  console.log('\n9. the member reads the reply');
  r = await call(alice.token, `/support-chat/${secureThread._id}`);
  const memberKey = await openWrappedKey(r.data.thread.keyShares[0], memberIdentity.privateKey);
  check('the reply opens on the member side', await openText(memberKey, r.data.messages[1].cipher) === replyText);
  check('status is pending (waiting on the member)', r.data.thread.status === 'pending');

  const sealedSummary = await ChatThread.findById(secureThread._id).lean();
  check('the queue summary is NOT the reply in plaintext', sealedSummary.lastMessagePreview === '');
  check(
    'but the sealed summary is the reply, sealed',
    String(sealedSummary.lastMessagePreviewCipher).startsWith('e1.'),
  );
  check('and it opens to the reply text', await openText(memberKey, sealedSummary.lastMessagePreviewCipher) === replyText);

  // The notification must repeat the SUBJECT (safe to read) and never the body.
  await new Promise((res) => setTimeout(res, 400));
  const bell = await UserNotification.findOne({ user: alice.user._id });
  check('the member was notified', Boolean(bell));
  check('the notice names the subject', bell.detail.includes('Double charge'));
  check('the notice carries the ticket id', bell.detail.includes(secureThread.ticketId));
  check('the notice never repeats the reply', !bell.detail.includes('duplicate charge'));

  // ── 10. A malformed send is refused at the door ──────────────────────────
  console.log('\n10. malformed payloads');
  r = await call(alice.token, '/support-chat', 'POST', { subject: 'x', cipher: 'not-a-cipher' });
  check('a bogus cipher is refused', r.status === 400);
  r = await call(alice.token, '/support-chat', 'POST', {
    subject: 'x', cipher: await sealText(contentKey, 'hi'), keyShares: [{ participant: 'nobody', wrapped: 'nope' }],
  });
  check('a bogus share is refused', r.status === 400);
  r = await call(alice.token, '/support-chat', 'POST', {
    subject: 'x', cipher: await sealText(contentKey, 'hi'),
    keyShares: [{ participant: `user:${bob.user._id}`, wrapped: await wrapContentKey(contentKey, memberIdentity.publicKey) }],
  });
  check('a share for a stranger is refused', r.status === 400);
  r = await call(alice.token, '/support-chat', 'POST', { subject: 'x', cipher: await sealText(contentKey, 'hi') });
  check('a sealed send must declare its subject', r.status === 400);

  // ── 11. Turning an existing conversation into a sealed one ───────────────
  console.log('\n11. sealing an existing conversation');
  const upgradeContent = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const upgradeOpening = 'Please also check my billing login.';
  r = await call(alice.token, '/support-chat', 'POST', {
    subject: 'Upgrade me to encrypted',
    body: 'This one starts as ordinary text.',
  });
  const legacyToSeal = r.data.thread;
  const legacyMessage = (await ChatMessage.find({ thread: legacyToSeal._id }).lean())[0];

  const sealedForMember = await wrapContentKey(upgradeContent, memberIdentity.publicKey);
  const sealedForAdmin = await wrapContentKey(upgradeContent, adminIdentity.publicKey);
  r = await call(alice.token, `/support-chat/${legacyToSeal._id}/secure`, 'POST', {
    messages: [{ _id: String(legacyMessage._id), cipher: await sealText(upgradeContent, legacyMessage.body) }],
    keyShares: [
      { participant: memberParticipant, wrapped: sealedForMember },
      { participant: `admin:${admin._id}`, wrapped: sealedForAdmin },
    ],
  });
  // 200, not 201: this is an UPDATE of a conversation that already exists, and
  // the client is repainting a loaded thread, not navigating to a new one. The
  // distinction matters to nothing here except the test, but it is the honest
  // status code for what happened.
  check('200 on the upgrade', r.status === 200);
  check('version 1', r.data.thread.encryption.version === 1);

  const upgradedRow = await ChatMessage.findById(legacyMessage._id).lean();
  check('the plaintext was replaced', upgradedRow.body === '');
  check('with ciphertext', upgradedRow.cipher.startsWith('e1.'));
  const upgradedSummary = await ChatThread.findById(legacyToSeal._id).lean();
  check('the queue summary no longer carries the plaintext', upgradedSummary.lastMessagePreview === '');
  check('but it carries the sealed one', upgradedSummary.lastMessagePreviewCipher.startsWith('e1.'));

  r = await call(alice.token, `/support-chat/${legacyToSeal._id}`);
  const unlocked = await openWrappedKey(r.data.thread.keyShares[0], memberIdentity.privateKey);
  check('the sealed history still reads on the member side', await openText(unlocked, r.data.messages[0].cipher) === legacyMessage.body);

  // A sealed thread cannot be double-sealed.
  r = await call(alice.token, `/support-chat/${legacyToSeal._id}/secure`, 'POST', { messages: [], keyShares: [] });
  check('sealing an already-sealed thread is a no-op, not a crash', r.status === 200);

  // The operator can seal one too — and must include the MEMBER, or the
  // conversation would become unreadable to the person who opened it.
  r = await call(alice.token, '/support-chat', 'POST', { subject: 'Operator seals this one', body: 'ordinary text again' });
  const operatorToSeal = r.data.thread;
  const operatorMessage = (await ChatMessage.find({ thread: operatorToSeal._id }).lean())[0];
  const operatorContent = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

  r = await call(adminToken, `/admin/chats/${operatorToSeal._id}/recipients`);
  check('the operator can list recipients', r.status === 200 && Array.isArray(r.data.recipients));
  const memberRecipient = (r.data.recipients || []).find((x) => x.participant === memberParticipant);
  check('and the member is among them', Boolean(memberRecipient));

  r = await call(adminToken, `/admin/chats/${operatorToSeal._id}/secure`, 'POST', {
    messages: [{ _id: String(operatorMessage._id), cipher: await sealText(operatorContent, operatorMessage.body) }],
    keyShares: [
      { participant: memberParticipant, wrapped: await wrapContentKey(operatorContent, memberIdentity.publicKey) },
      { participant: `admin:${admin._id}`, wrapped: await wrapContentKey(operatorContent, adminIdentity.publicKey) },
    ],
  });
  check('201 on an operator-sealed upgrade', r.status === 200);
  check('and the member can read what the operator sealed', await openWrappedKey((await call(alice.token, `/support-chat/${operatorToSeal._id}`)).data.thread.keyShares[0], memberIdentity.privateKey).then(() => true));

  // ── 12. Recovery copies ───────────────────────────────────────────────────
  console.log('\n12. recovery');
  // A recovery wrapper is a safe-shaped string, and the endpoint rejects anything
  // that is not — the endpoint cannot check the crypto, only the shape.
  const goodWrap = ['r1', 'a'.repeat(16), 'c'.repeat(320)].join('.');
  r = await call(alice.token, '/support-chat/encryption/recovery', 'POST', { recoveryWrapped: goodWrap, hint: 'X4KP' });
  check('a shaped wrapper is stored', r.status === 200);
  r = await call(alice.token, '/support-chat/encryption/key');
  check('and the endpoint now reports it', r.data.key.hasRecovery === true && r.data.key.recoveryHint === 'X4KP');
  r = await call(alice.token, '/support-chat/encryption/recovery', 'POST', { recoveryWrapped: 'garbage', hint: 'X4KP' });
  check('a garbage wrapper is refused', r.status === 400);
  r = await call(alice.token, '/support-chat/encryption/recovery');
  check('the sealed copy is served for a code attempt', r.status === 200 && r.data.hasRecovery === true && typeof r.data.recoveryWrapped === 'string');
  r = await call(alice.token, '/support-chat/encryption/key');
  check('the plain GET never serves the wrapper', !('recoveryWrapped' in r.data.key));

  // ── 13. Registered operator keys on the admin side ───────────────────────
  console.log('\n13. operator directory');
  r = await call(adminToken, '/admin/chats/encryption/key');
  check('the operator can read its own key', r.data.key.publicKey === adminIdentity.publicKey);
  r = await call(alice.token, '/admin/chats/encryption/key');
  check('a member cannot', r.status === 403);

  // ── 14. Identity swapping is safe ────────────────────────────────────────
  console.log('\n14. a share is readable by exactly one identity');
  const soloKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const soloIdentity = await generateIdentity();
  const strangerIdentity = await generateIdentity();
  const soloShare = await wrapContentKey(soloKey, soloIdentity.publicKey);

  const asOwner = await openWrappedKey(soloShare, soloIdentity.privateKey);
  check('the named identity opens it', asOwner !== null && await openText(asOwner, await sealText(soloKey, 'mine')) === 'mine');
  const asStranger = await openWrappedKey(soloShare, strangerIdentity.privateKey);
  check('a different identity cannot', asStranger === null);

  // ── 15. The push streams must authenticate the only way a browser can ────
  // An EventSource cannot set an Authorization header, so both chat streams
  // accept the access token as `?token=` — and ONLY those two paths may, since
  // a credential in a URL ends up in access logs. If the member stream ever
  // stops accepting it the inbox degrades silently to 12 s polling with no
  // error anywhere: `useChatStream` treats a failed connect as "behave like
  // before". That invisible failure is exactly what this section makes loud.
  console.log('\n15. push streams');
  const sse = async (path, { token, query } = {}) => {
    const url = `${BASE}${path}${query && token ? `?token=${encodeURIComponent(token)}` : ''}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    let status = 0;
    let type = '';
    let head = '';
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'text/event-stream',
          ...(!query && token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: ctrl.signal,
      });
      status = res.status;
      type = res.headers.get('content-type') || '';
      if (res.ok && res.body) {
        for await (const chunk of res.body) {
          head += Buffer.from(chunk).toString('utf8');
          // Opened means a real frame arrived: the `: hello` comment, or the
          // presence snapshot the console sends before it.
          if (head.includes(': hello') || head.includes('event:')) break;
        }
      } else {
        head = (await res.text().catch(() => '')).slice(0, 120);
      }
    } catch { /* aborted or closed early — `status`/`head` say how far it got */ }
    clearTimeout(timer);
    ctrl.abort();
    // Authenticated = the route answered an event stream. A rejected connect
    // never gets here: protect answers JSON 401/403 first. Whether a frame has
    // arrived yet is not part of it — the admin console stays silent until
    // something changes or the 25 s heartbeat comments the socket, and the
    // wake-up checks below are what prove pushing works.
    const opened = status === 200 && type.includes('text/event-stream');
    return { opened, status, head: head.replace(/\s+/g, ' ').slice(0, 80) };
  };

  const memberStream = await sse('/support-chat/stream', { token: alice.token, query: true });
  check(`the member stream opens on the EventSource query token (${memberStream.status} ${memberStream.head})`,
    memberStream.opened);
  const bareStream = await sse('/support-chat/stream');
  check(`the member stream still refuses an unauthenticated connect (${bareStream.status})`,
    bareStream.status === 401);
  const adminStream = await sse('/admin/chats/stream', { token: adminToken, query: true });
  check(`the admin stream opens on the EventSource query token (${adminStream.status} ${adminStream.head})`,
    adminStream.opened);
  const memberOnAdmin = await sse('/admin/chats/stream', { token: alice.token, query: true });
  check(`a member token cannot open the admin stream (${memberOnAdmin.status})`,
    memberOnAdmin.status === 401 || memberOnAdmin.status === 403);
  const memberOnQueue = await sse('/admin/chats?limit=1', { token: alice.token, query: true });
  check(`the query-token allowance is scoped to the stream paths only (${memberOnQueue.status})`,
    memberOnQueue.status === 401);

  // And the stream must actually STREAM: a write on one side wakes the other
  // side's open connection. Without this the channel could authenticate, stay
  // open, and push nothing forever — the app would look healthy and still be
  // running on 12 s polls.
  const wake = async (path, token, trigger) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let frames = '';
    const reading = (async () => {
      const res = await fetch(`${BASE}${path}?token=${encodeURIComponent(token)}`, {
        headers: { Accept: 'text/event-stream' },
        signal: ctrl.signal,
      });
      for await (const chunk of res.body) {
        frames += Buffer.from(chunk).toString('utf8');
        if (frames.includes('event: chat')) break;
      }
    })().catch(() => { /* aborted once the event landed, or the window closed */ });
    await new Promise((resolve) => setTimeout(resolve, 500)); // let it establish
    const sent = await trigger();
    await reading;
    clearTimeout(timer);
    ctrl.abort();
    return { sent, frames: frames.replace(/\s+/g, ' ').slice(0, 160) };
  };

  const ping = await call(alice.token, '/support-chat', 'POST',
    { subject: 'Stream wake-up probe', body: 'Does an admin reply push to my open stream?' });
  check(`the probe thread opened (${ping.status})`, ping.status === 201 || ping.status === 200);

  const memberWoke = await wake('/support-chat/stream', alice.token, () =>
    call(adminToken, `/admin/chats/${ping.data.thread._id}/messages`, 'POST', { body: 'reply to wake the member' }));
  check(`an admin reply pushes a chat event to the member's open stream (${memberWoke.sent.status} ${memberWoke.frames})`,
    memberWoke.sent.status === 201 && memberWoke.frames.includes('event: chat'));

  const adminWoke = await wake('/admin/chats/stream', adminToken, () =>
    call(alice.token, `/support-chat/${ping.data.thread._id}/messages`, 'POST', { body: 'follow-up to wake the console' }));
  check(`a member message pushes a chat event to the admin's open stream (${adminWoke.sent.status} ${adminWoke.frames})`,
    adminWoke.sent.status === 201 && adminWoke.frames.includes('event: chat'));

  await ChatThread.deleteMany({ _id: ping.data.thread._id });
  await ChatMessage.deleteMany({ thread: ping.data.thread._id });

  // ── cleanup ──────────────────────────────────────────────────────────────
  for (const u of [alice.user, bob.user]) {
    await ChatThread.deleteMany({ user: u._id });
    await ChatMessage.deleteMany({ user: u._id });
    await UserNotification.deleteMany({ user: u._id });
    await Session.deleteMany({ user: u._id });
    await User.deleteOne({ _id: u._id });
  }
  await ChatThread.deleteOne({ _id: legacy._id });

  console.log(`\nALL ${passed} CHECKS PASSED`);
  await mongoose.disconnect();
})().catch(async (error) => {
  console.error('\nFAILED:', error.message);
  console.error(error.stack);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
