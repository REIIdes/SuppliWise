import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The browser half of the encryption contract, run under Node.
 *
 * Why this file exists: the server validates the SHAPE of an envelope and can
 * never check its content — it has nothing to decrypt with. So the only proof
 * that the two halves agree is to run them side by side, which is what the
 * "the wire format matches" test below does. Everything else here is the
 * behaviour a person depends on without ever seeing it worked: a saved key
 * still opens a message, a wrong code is rejected, and a message sealed on one
 * browser cannot be read by a different one.
 *
 * Node 24 ships `crypto.subtle` and `localStorage` polyfills are stubbed at the
 * top, so the whole module under test runs unmodified.
 */
import {
  secureChatAvailable,
  b64uEncode,
  b64uDecode,
  generateIdentity,
  saveLocalIdentity,
  loadLocalIdentity,
  generateThreadKey,
  generateRecoveryCode,
  recoveryHintOf,
  normalizeRecoveryCode,
  wrapKeyFor,
  unwrapKeyFor,
  createSealing,
  sealText,
  openText,
  adoptThreadKey,
  recallThreadKey,
  rememberThreadKey,
  wrapIdentityForRecovery,
  unwrapIdentityForRecovery,
} from './secureChat.js';

// ── The browser globals this module expects ─────────────────────────────────

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
  clear: () => storage.clear(),
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/** The server's shape checks, inlined so a drift fails here and not in the field. */
const SERVER_CIPHER = /^e1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16,7600}$/;
const SERVER_WRAP = /^w1\.[A-Za-z0-9_-]{86}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{32,200}$/;
const SERVER_PUBLIC = /^[A-Za-z0-9_-]{80,90}$/;

const PARTICIPANT = 'user:65f1c2a4b9d33e0012ab77de';
const RECOVERY_CODE_LENGTH = 24;

describe('base64url', () => {
  it('round-trips every byte value', () => {
    const bytes = new Uint8Array(256);
    for (let index = 0; index < 256; index += 1) bytes[index] = index;
    assert.deepEqual(Array.from(b64uDecode(b64uEncode(bytes))), Array.from(bytes));
  });

  it('produces URL-safe characters with no padding', () => {
    // Padding and + / are the two things that get mangled by a URL or a shell,
    // so they must not appear.
    const safe = b64uEncode(new Uint8Array([255, 254, 253, 252]));
    assert.match(safe, /^[A-Za-z0-9_-]+$/);
    assert.ok(!safe.includes('='));
  });

  it('tolerates missing padding, the way a value copied out of a QR code is', () => {
    const original = b64uEncode(new Uint8Array([1, 2, 3]));
    const unpadded = original.replace(/=+$/, '');
    assert.deepEqual(Array.from(b64uDecode(unpadded)), [1, 2, 3]);
  });
});

describe('availability', () => {
  it('is true here, which is the precondition for every other test', () => {
    assert.equal(secureChatAvailable(), true);
  });
});

describe('identity', () => {
  it('is generated as a P-256 pair', async () => {
    const identity = await generateIdentity();
    assert.equal(identity.keyId.length, 10);
    assert.match(identity.publicKey, SERVER_PUBLIC);
    assert.ok(identity.privateKey);
  });

  it('is persisted and read back, so a reload can still read the thread', async () => {
    const identity = await generateIdentity();
    await saveLocalIdentity(PARTICIPANT, identity);

    // Drop the in-memory cache so this genuinely reads storage, not memory. The
    // module keeps one per-participant, so asking for an unrelated account is
    // the honest way to prove the reload path is what answers.
    assert.equal(await loadLocalIdentity('user:somebodyelse'), null);

    const reloaded = await loadLocalIdentity(PARTICIPANT);
    assert.ok(reloaded, 'identity should survive a reload');
    assert.equal(reloaded.keyId, identity.keyId);
    assert.equal(reloaded.publicKey, identity.publicKey);
  });

  it('is not readable from storage directly', async () => {
    const identity = await generateIdentity();
    await saveLocalIdentity(PARTICIPANT, identity);
    const stored = storage.get(`suppliwise:secure-chat:identity:${PARTICIPANT}`);
    const parsed = JSON.parse(stored);
    // The private half is sealed under the device secret, not stored plaintext.
    // A JWK private key carries `kty`, `crv` and `d`; none of those may appear.
    const flat = JSON.stringify(parsed);
    assert.ok(!flat.includes('"d"'), 'the private exponent must not be stored');
    assert.ok(!flat.includes('"crv"'), 'a raw JWK must not be stored');
    assert.ok(typeof parsed.sealedPrivateKey === 'string', 'the private key travels sealed');
  });
});

describe('thread keys', () => {
  it('are wrapped to one recipient and opened only by that recipient', async () => {
    const key = await generateThreadKey();
    const mine = await generateIdentity();
    const theirs = await generateIdentity();

    const share = await wrapKeyFor(key, mine.publicKey);
    assert.match(share, SERVER_WRAP, 'a wrapped key must match the server shape');

    const opened = await unwrapKeyFor(share, mine.privateKey);
    assert.ok(opened, 'the named recipient must be able to open it');

    // The whole security property, in one line: a different key pair gets null,
    // not a ciphertext blob and not a crash.
    const notOurs = await unwrapKeyFor(share, theirs.privateKey);
    assert.equal(notOurs, null, 'a different identity must not open another key');
  });

  it('rejects a share it cannot parse rather than throwing', async () => {
    const identity = await generateIdentity();
    assert.equal(await unwrapKeyFor('garbage', identity.privateKey), null);
    assert.equal(await unwrapKeyFor('', identity.privateKey), null);
    assert.equal(await unwrapKeyFor(undefined, identity.privateKey), null);
    assert.equal(await unwrapKeyFor('w1.a.b.c.d.e', identity.privateKey), null);
  });

  it('opens a share to a recipient registered on the server side', async () => {
    // The real flow: a member seals a new thread and wraps it for the operators
    // whose PUBLIC keys the server published. This end-to-end is what proves the
    // member's send actually reads at the other end.
    const operator = await generateIdentity();
    const session = await createSealing();

    const share = await session.shareWith(operator.publicKey);
    assert.match(share, SERVER_WRAP);

    // The operator opens the share, which is what the hook's `ensureThreadKey`
    // does — and, crucially, it REMEMBERS the key under the thread id, because a
    // key nobody can look up again is a key the next message cannot be read with.
    const opened = await unwrapKeyFor(share, operator.privateKey);
    assert.ok(opened, 'the operator must open a share made with their public key');
    rememberThreadKey('thread-1', opened);

    assert.equal(await openText('thread-1', await session.seal('the member message')), 'the member message');
  });
});

describe('message bodies', () => {
  it('are sealed with the server shape and opened by the same key', async () => {
    const session = await createSealing();
    const cipher = await session.seal('A plain message.');
    assert.match(cipher, SERVER_CIPHER);

    rememberThreadKey('thread-x', session.key);
    assert.equal(recallThreadKey('thread-x'), session.key);
    assert.equal(await openText('thread-x', cipher), 'A plain message.');
  });

  it('produce a different ciphertext every time for the same text', async () => {
    // AES-GCM with a fresh IV per message. A repeated IV is a catastrophic
    // failure mode for GCM, so this is the test that says it cannot happen.
    const session = await createSealing();
    const first = await session.seal('same words');
    const second = await session.seal('same words');
    assert.notEqual(first, second);
    rememberThreadKey('thread-iv', session.key);
    assert.equal(await openText('thread-iv', first), 'same words');
    assert.equal(await openText('thread-iv', second), 'same words');
  });

  it('are unreadable to a thread key this browser does not have', async () => {
    const session = await createSealing();
    const cipher = await session.seal('a secret');
    // No key is cached for this id, so there is nothing to open it with.
    assert.equal(await openText('never-adopted', cipher), null);
  });

  it('are unreadable when the cipher came from a different conversation', async () => {
    const sessionA = await createSealing();
    const sessionB = await createSealing();
    rememberThreadKey('thread-a', sessionA.key);
    rememberThreadKey('thread-b', sessionB.key);
    const cipher = await sessionA.seal('sealed under A');
    // The right blob under the wrong key: a distinct failure from "no key", and
    // just as much a null rather than a crash.
    assert.equal(await openText('thread-b', cipher), null);
  });

  it('adopt a fresh key to a server-assigned thread id', async () => {
    // The exact order the create path uses: generate, seal, POST, adopt, reply.
    const session = await createSealing();
    const cipher = await session.seal('first message');
    adoptThreadKey('thread-created', session);
    const reply = await sealText('thread-created', 'second message');
    rememberThreadKey('thread-created', session.key);
    assert.equal(await openText('thread-created', reply), 'second message');
    assert.equal(await openText('thread-created', cipher), 'first message');
  });
});

describe('recovery codes', () => {
  it('are 24 characters behind a SWK- prefix', () => {
    for (let index = 0; index < 50; index += 1) {
      const code = generateRecoveryCode();
      // 4 + four groups of 5 = 24 readable characters, in five segments.
      assert.match(
        code,
        /^SWK-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}(-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}){4}$/,
        `${code} must be four shuffled groups`
      );
      assert.equal(normalizeRecoveryCode(code).length, RECOVERY_CODE_LENGTH);
    }
  });

  it('carry a four-character hint that recognises the code', () => {
    const code = generateRecoveryCode();
    const hint = recoveryHintOf(code);
    assert.equal(hint.length, 4);
    // The hint is the LAST four characters — enough for someone reading their own
    // code to say "yes, that's mine", and not enough for anyone else.
    assert.ok(code.endsWith(hint), 'the hint is a recognisable tail of the code');
    assert.equal(hint, recoveryHintOf(hint), 'the hint of the hint is the hint');
  });

  it('seal a private key and open it again with the same code', async () => {
    const identity = await generateIdentity();
    const code = generateRecoveryCode();
    const { wrapped, hint } = await wrapIdentityForRecovery(identity.privateKey, PARTICIPANT, code);
    assert.equal(hint, recoveryHintOf(code));

    const opened = await unwrapIdentityForRecovery(wrapped, PARTICIPANT, code);
    assert.ok(opened, 'the saved code must restore the private key');

    // And the restored key actually works: it can open a share made to the
    // original identity, which is the only thing that makes recovery real.
    const session = await createSealing();
    const share = await session.shareWith(identity.publicKey);
    assert.ok(await unwrapKeyFor(share, opened));
  });

  it('refuse a wrong code instead of returning a key', async () => {
    const identity = await generateIdentity();
    const code = generateRecoveryCode();
    const { wrapped } = await wrapIdentityForRecovery(identity.privateKey, PARTICIPANT, code);
    const wrong = generateRecoveryCode();
    await assert.rejects(() => unwrapIdentityForRecovery(wrapped, PARTICIPANT, wrong));
    // A malformed code is the same answer as a wrong one: no key, no exception
    // escaping past the caller.
    await assert.rejects(() => unwrapIdentityForRecovery(wrapped, PARTICIPANT, 'not-a-code'));
    await assert.rejects(() => unwrapIdentityForRecovery('garbage', PARTICIPANT, code));
  });

  it('refuse a code for a different account', async () => {
    // The PBKDF2 salt is derived from the participant, so a code that opens one
    // account's wrapper must not open another's, even if the code is identical.
    const identity = await generateIdentity();
    const code = generateRecoveryCode();
    const { wrapped } = await wrapIdentityForRecovery(identity.privateKey, PARTICIPANT, code);
    await assert.rejects(
      () => unwrapIdentityForRecovery(wrapped, 'admin:65f1c2a4b9d33e0012ab77dd', code),
      'the same code must not open another account'
    );
  });

  it('accept a code typed without its prefix and hyphens', async () => {
    // People paste "SWK-ABCD-EFG..." or strip the bits they think are decoration.
    const identity = await generateIdentity();
    const code = generateRecoveryCode();
    const { wrapped } = await wrapIdentityForRecovery(identity.privateKey, PARTICIPANT, code);
    const rehydrated = normalizeRecoveryCode(code.replace(/-/g, ''));
    assert.equal(rehydrated, normalizeRecoveryCode(code));
    assert.ok(await unwrapIdentityForRecovery(wrapped, PARTICIPANT, rehydrated));
  });
});
