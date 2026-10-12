import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  adoptThreadKey,
  createSealing,
  ensureThreadKey,
  forgetLocalIdentity,
  forgetThreadKeys,
  generateIdentity,
  loadLocalIdentity,
  openText,
  recallThreadKey,
  saveLocalIdentity,
  secureChatAvailable,
  sealText,
  wrapKeyFor,
} from './secureChat';

/**
 * END-TO-END ENCRYPTION — the React wiring.
 *
 * This is the only place the crypto module meets the network. Everything it
 * exposes answers one of three questions: "can this browser seal a message",
 * "can it open this conversation", and "who can it seal to". Each of those has a
 * wrong answer that looks exactly like a right one, and each is isolated here so
 * the components can be straightforward about it.
 *
 * ── Why a hook and not a context provider ──────────────────────────────────
 * Two components use it and they are never on screen together. A context
 * provider would have to own the participant id, which differs between a member
 * session and an admin one, so it would land at the app root with the identity
 * drilled in from two unrelated routers. A hook handed the props the component
 * already has is the same behaviour with none of that plumbing.
 *
 * ── Why bootstrap is one awaited effect ─────────────────────────────────────
 * The identity has to exist before the first conversation is opened, which
 * means before anything else in the component runs. One awaited bootstrap
 * resolving to a single `status` means no render can race it: either the
 * transcript waits for it or it is already there. A cascade of smaller effects
 * would leave a window where a conversation renders with ciphertext still
 * sitting in the message body — the worst thing this feature could do.
 *
 * ── Why a failure to publish is not a failure to encrypt ───────────────────
 * The identity is local; publishing it is what makes THIS browser a valid
 * recipient. A member on a flaky connection who has just typed a question must
 * not lose it because one request failed, so a publish failure yields
 * `ready-unpublished` and the message goes out as ordinary text with a reason
 * attached. It never blocks the send.
 *
 * ── Why a new browser never overwrites a registered key ────────────────────
 * Overwriting would break the OTHER browser's ability to open new
 * conversations, which is worse than the thing it would fix. So the server is
 * asked what the account already has, and a browser that never held the key
 * enters `needs-key` with an explanation and an offer to paste the recovery
 * code — never a silent regeneration. The one exception is the reset button
 * itself: that IS the user choosing to overwrite, so it mints and publishes a
 * fresh key without re-asking the server first.
 *
 * ── Why a bad cached key repairs itself but a failed request only waits ─────
 * A 400 from the publish means the server rejects THIS key's shape — the one
 * failure an immediate regeneration actually fixes (typically an identity
 * cached by an older build). Every other publish failure is a condition of the
 * network or the server, where wiping a perfectly good key would cost the
 * member access to their own conversations. So 400 regenerates once, anything
 * else keeps the key and retries quietly in the background, which is also what
 * clears the "could not be shared" banner without asking for a reload.
 */

// Mirrors of the server's checks — utils/chatKeys.js (KEY_ID_PATTERN) and
// utils/chatEncryption.js (PUBLIC_KEY_PATTERN). A cached identity that fails
// these can only ever earn a 400, so it is treated as absent rather than
// published and retried forever.
const KEY_ID_SHAPE = /^[a-z0-9]{6,32}$/;
const PUBLIC_KEY_SHAPE = /^[A-Za-z0-9_-]{80,90}$/;

const isWellFormedIdentity = (identity) => Boolean(
  identity?.privateKey
  && KEY_ID_SHAPE.test(String(identity.keyId || ''))
  && PUBLIC_KEY_SHAPE.test(String(identity.publicKey || ''))
);

// How long to leave a failed publish alone before trying again, quietly.
const PUBLISH_RETRY_MS = 30000;

export default function useSecureChat({ role, accountId, isAuthenticated = true, endpoints = {} }) {
  const participant = useMemo(
    () => (accountId ? `${role}:${String(accountId)}` : ''),
    [role, accountId]
  );

  // Both callers pass `endpoints` as an inline object literal, so its identity
  // changes on EVERY render. Kept in a ref that bootstrap and loadRecipients
  // read at call time — otherwise each render would re-trigger bootstrap (a
  // publishKey POST and identity rewrite per render, which in turn re-renders),
  // and the returned callbacks would churn with it.
  const endpointsRef = useRef(endpoints);
  useEffect(() => { endpointsRef.current = endpoints; }, [endpoints]);

  const [status, setStatus] = useState(secureChatAvailable() ? 'booting' : 'unavailable');
  // 'ready'              identity held locally AND published — can start sealed
  //                      conversations and read the ones it can open
  // 'ready-unpublished' identity is local but the server does not know this
  //                      browser yet. Sealing would produce a conversation
  //                      nobody else can open, so this is a not-yet state and
  //                      `canSealNew` stays false.
  // 'needs-key'          this browser has never held the key and the account has
  //                      one elsewhere. Older conversations cannot be read here.
  // 'booting'            still working.
  // 'unavailable'        no WebCrypto, no endpoints, or signed out.

  const [identity, setIdentity] = useState(null);
  const [replacedKeyId, setReplacedKeyId] = useState('');
  const [recoveryAvailable, setRecoveryAvailable] = useState(null);
  const [reason, setReason] = useState('');
  const [supported] = useState(secureChatAvailable);
  // How many OTHER parties this browser can seal a new conversation to.
  //
  // `null` means "not checked yet" — the state while bootstrap is running, and
  // the permanent state on the admin router where recipients are per
  // conversation rather than an up-front directory. `0` means checked and there
  // is nobody, which is the one value that must stop a new conversation from
  // being sealed: a message sealed to only its author is a message nobody else
  // can ever read, which is the worst outcome this feature could produce.
  const [recipientCount, setRecipientCount] = useState(null);

  // Guards an in-flight bootstrap against a fast account switch.
  const runRef = useRef(0);
  // A failed publish retries itself quietly — see the header note. Held in a
  // ref so a re-render never stacks timers, and read through bootstrapRef so
  // the delayed call always runs the CURRENT bootstrap, not the closure that
  // scheduled it (which may belong to a signed-out participant).
  const retryTimer = useRef(null);
  const bootstrapRef = useRef(null);

  // The thread-key and plaintext caches are module-level and keyed only by
  // thread id, so an account switch inside the same tab would leave the next
  // participant sealing replies with a key they cannot re-open — the message
  // reads as "this device does not hold the key" the moment the page reloads.
  // Nothing legitimately shares a tab across participants, so drop the caches
  // whenever the participant changes.
  useEffect(() => {
    forgetThreadKeys();
  }, [participant]);

  // `force` is the explicit reset path: the browser has just been told "drop
  // your key and start over", so asking the server for the key it already
  // refused to recover would just re-enter `needs-key` and make the reset button
  // a no-op. A forced run skips the registered-key probe and mints a fresh
  // identity immediately; publishing it replaces the server-side key.
  const bootstrap = useCallback(async (quiet = false, force = false) => {
    const eps = endpointsRef.current;
    const run = runRef.current + 1;
    runRef.current = run;
    if (retryTimer.current) { window.clearTimeout(retryTimer.current); retryTimer.current = null; }
    // A late bootstrap from a previous account must never paint its result over
    // this one. Without this, signing out and back in as somebody else can leave
    // the second member looking at the first member's keys.
    const stillCurrent = () => runRef.current === run;

    // A quiet retry keeps the current banner in place rather than flashing the
    // whole panel through 'booting' every 30 seconds; success clears it below.
    if (!quiet) {
      setReason('');
      setRecoveryAvailable(null);
      setReplacedKeyId('');
      setRecipientCount(null);
    }

    if (!supported) {
      setStatus('unavailable');
      setReason('This browser or connection cannot do end-to-end encryption, so messages are sent as ordinary text.');
      return;
    }
    if (!isAuthenticated || !participant) {
      setStatus('unavailable');
      setReason('Sign in to send encrypted messages.');
      return;
    }
    if (!eps.getKey || !eps.publishKey) {
      // Missing wiring rather than missing crypto. Calling this "unavailable"
      // would be a lie, but there is nothing else it can do.
      setStatus('unavailable');
      setReason('Encrypted messaging is not available just now.');
      return;
    }

    if (!quiet) setStatus('booting');
    try {
      let local = await loadLocalIdentity(participant);

      if (local && !isWellFormedIdentity(local)) {
        // A cached identity an older build wrote — a key id or public key the
        // server's validation can only ever reject. Keeping it means a
        // permanent warning banner; treating it as absent lets the flow below
        // either recover it from the server or mint a well-formed one.
        forgetLocalIdentity(participant);
        local = null;
      }

      if (!local) {
        // Ask the server what the account already has. A key it has never seen
        // is a first run; one it HAS seen on a browser that has no private half is
        // the case this branch exists to detect. Skipped on an explicit reset —
        // see the `force` note above.
        if (!force) {
          let registered = null;
          try { registered = (await eps.getKey())?.key || null; } catch { registered = null; }

          if (registered && registered.publicKey) {
            setRecoveryAvailable(registered);
            setStatus('needs-key');
            setReason('This browser does not hold your message key. Older conversations cannot be read here — paste your recovery code to unlock them.');
            return;
          }
        }
        local = await generateIdentity();
        await saveLocalIdentity(participant, local);
      }

      if (!stillCurrent()) return;
      setIdentity(local);

      let published = null;
      let publishError = null;
      try {
        published = await eps.publishKey({ keyId: local.keyId, publicKey: local.publicKey });
      } catch (error) {
        publishError = error;
      }

      // A 400 is the server saying THIS key is not a valid one — the single
      // failure an immediate regeneration actually fixes. The swap costs the
      // old conversations their reader (exactly as any key swap does, and the
      // replacedKeyId note below says so), which still beats a permanent
      // banner. Every other failure is a condition of the network or the
      // server, where wiping a good key would lock the member out of their own
      // history to fix nothing — so the key stays and the retry waits.
      if (publishError?.status === 400) {
        forgetLocalIdentity(participant);
        forgetThreadKeys();
        setIdentity(null);
        publishError = null;
        try {
          local = await generateIdentity();
          await saveLocalIdentity(participant, local);
          if (!stillCurrent()) return;
          published = await eps.publishKey({ keyId: local.keyId, publicKey: local.publicKey });
        } catch (retryError) {
          publishError = retryError;
        }
      }

      if (publishError) {
        if (stillCurrent()) {
          setStatus('ready-unpublished');
          setReason(role === 'admin'
            ? 'Your encryption key could not be shared with the server yet, so this conversation is sent as ordinary text.'
            : 'Your encryption key could not be shared with the support team yet, so this conversation is sent as ordinary text.');
          if (retryTimer.current) window.clearTimeout(retryTimer.current);
          retryTimer.current = window.setTimeout(() => { bootstrapRef.current?.(true); }, PUBLISH_RETRY_MS);
        }
        return;
      }

      if (!stillCurrent()) return;
      const publicKey = published?.key?.publicKey || local.publicKey;
      setIdentity({ keyId: local.keyId, publicKey });
      setReplacedKeyId(published?.replacedKeyId || '');
      setStatus('ready');
      setReason('');

      // Who can a NEW conversation be sealed to? Checked here, once, because it
      // is the one question that decides whether encrypting is even the right
      // choice. A member with no operator key published gets plaintext and a
      // reason; anything else gets sealed.
      if (eps.listRecipients) {
        try {
          const recipients = toRecipientList(await eps.listRecipients(null));
          if (stillCurrent()) setRecipientCount(recipients.length);
        } catch {
          if (stillCurrent()) setRecipientCount(0);
        }
      }
    } catch (error) {
      if (!stillCurrent()) return;
      setStatus('unavailable');
      setReason(error?.message || 'Encrypted messaging could not start.');
    }
  }, [participant, isAuthenticated, supported, role]);

  useEffect(() => {
    let live = true;
    bootstrapRef.current = bootstrap;
    (async () => {
      if (live) await bootstrap();
    })();
    return () => {
      live = false;
      runRef.current += 1;
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
    };
  }, [bootstrap]);

  // ── Thread access ────────────────────────────────────────────────────────

  /** Unwrap and cache a conversation's key. */
  const unlock = useCallback(async (thread) => {
    if (!thread) return false;
    if (!Number(thread.encryption?.version)) return true;
    const wrapped = Array.isArray(thread.keyShares) ? thread.keyShares : [];
    const key = await ensureThreadKey(thread._id, wrapped, participant);
    return Boolean(key);
  }, [participant]);

  const attachThread = unlock;

  const hasKey = useCallback((threadId) => Boolean(recallThreadKey(threadId)), []);

  /** One message body, decrypted. null means "this browser cannot open it". */
  const openBody = useCallback((threadId, cipher) => (
    cipher ? openText(threadId, cipher) : Promise.resolve(null)
  ), []);

  /**
   * Resolve a whole transcript in one await.
   *
   * One pass rather than one component per message: decrypting 500 blobs fires
   * 500 promises, and mounting 500 waiting components to do it makes the
   * transcript flicker. This returns every body at once, in order, and the
   * component renders from the result.
   *
   * @returns {Promise<Array<{_id, body:string|null, encrypted:boolean}>>}
   */
  const openRows = useCallback(async (threadId, messages) => (
    Promise.all((messages || []).map(async (message) => {
      if (!message.cipher) return { ...message, body: message.body || null, encrypted: false };
      const body = await openText(threadId, message.cipher);
      return { ...message, body, encrypted: true };
    }))
  ), []);

  /**
   * The preview line for a sealed row in the list.
   *
   * The row arrives with a wrapped key, so this unlocks it rather than assuming
   * the key is already cached — otherwise every preview on a cold page would
   * read "unavailable" until that thread happened to be opened.
   */
  const openPreview = useCallback(async (thread) => {
    if (!thread || !Number(thread.encryption?.version) || !thread.lastMessagePreviewCipher) return null;
    await unlock(thread);
    return openText(thread._id, thread.lastMessagePreviewCipher);
  }, [unlock]);

  const sealReply = useCallback((threadId, text) => sealText(threadId, text), []);

  /**
   * The list of public keys this browser can seal to.
   *
   * `null` means "not checked" — which is the state on the admin router, where
   * recipients are per conversation and are fetched with the id rather than up
   * front. A member's count is fetched during bootstrap, because it decides
   * whether a NEW conversation can be sealed at all.
   */
  const loadRecipients = useCallback(async (threadId = null) => {
    const listRecipients = endpointsRef.current.listRecipients;
    if (!listRecipients) return null;
    try {
      return toRecipientList(await listRecipients(threadId));
    } catch {
      return null;
    }
  }, []);

  /**
   * Start sealing a NEW conversation.
   *
   * @returns {Promise<Sealing|null>} null when this browser cannot seal, so the
   *   caller falls back to ordinary text rather than failing the send.
   */
  const beginThread = useCallback(async () => {
    if (status !== 'ready' || !identity?.publicKey) return null;
    return createSealing();
  }, [status, identity]);

  const adoptThread = useCallback((threadId, sealing) => {
    if (threadId) adoptThreadKey(threadId, sealing);
  }, []);

  /**
   * Re-seal an EXISTING conversation's key to a list of recipients.
   *
   * This is the grant path, and it is deliberately a different function from
   * `buildShares`: a grant has to wrap the key that is ALREADY readable by the
   * people being granted to. Wrapping a fresh one would hand out keys to
   * conversations nobody else can open.
   *
   * @returns {Promise<Array<{participant, wrapped}>>} [] when this browser has
   *   no key for the conversation, which is the caller's signal to say so.
   */
  const rewrapTo = useCallback(async (threadId, recipients) => {
    const key = recallThreadKey(String(threadId));
    if (!key) return [];
    const shares = [];
    for (const recipient of Array.isArray(recipients) ? recipients : []) {
      if (!recipient?.participant || !recipient?.publicKey) continue;
      const wrapped = await wrapKeyFor(key, recipient.publicKey);
      shares.push({ participant: recipient.participant, wrapped });
    }
    return shares;
  }, []);

  /**
   * Wrap a new conversation's key for every party who needs to read it.
   *
   * The caller is always in the list: without their own share they could send
   * the message and then be unable to read it back, which is a self-inflicted
   * data loss.
   */
  const buildShares = useCallback(async (sealing, threadId = null) => {
    if (!sealing) return [];
    const recipients = (await loadRecipients(threadId)) || [];
    const own = identity?.publicKey ? [{ participant, publicKey: identity.publicKey }] : [];
    const all = [...own, ...recipients];
    const shares = [];
    for (const recipient of all) {
      if (!recipient?.participant || !recipient?.publicKey) continue;
      const wrapped = await wrapKeyFor(sealing.key, recipient.publicKey);
      shares.push({ participant: recipient.participant, wrapped });
    }
    return shares;
  }, [loadRecipients, identity, participant]);

  const forgetIdentity = useCallback(() => {
    if (participant) forgetLocalIdentity(participant);
    forgetThreadKeys();
    setIdentity(null);
    setStatus('unavailable');
  }, [participant]);

  /**
   * Escape hatch for `needs-key` on a browser that cannot produce the recovery
   * code: drop the unusable local state, generate a fresh identity, and publish
   * it. Older conversations stay sealed to the old key — that is what
   * end-to-end encryption means — but this browser stops being locked out of
   * everything that comes next.
   */
  const resetIdentity = useCallback(async () => {
    if (participant) forgetLocalIdentity(participant);
    forgetThreadKeys();
    setIdentity(null);
    setRecoveryAvailable(null);
    await bootstrap(false, true);
  }, [participant, bootstrap]);

  // Memoised so callers can depend on `secure` in their own useCallbacks. A
  // fresh object every render made `loadList`/`load` unstable in both inbox
  // components, which re-ran their fetch effects on every render and tore down
  // and rebuilt the 12 s poll interval with them.
  return useMemo(() => ({
    status,
    identity,
    reason,
    supported,
    replacedKeyId,
    recoveryAvailable,
    recipientCount,
    // Sealing a NEW conversation needs a published identity AND somebody on the
    // other end to seal to. With no operator key published, sealing would
    // produce a ticket nobody can read — so this stays false and the member's
    // message goes out as ordinary text, with the reason saying why.
    canSealNew: status === 'ready' && Boolean(identity?.publicKey) && recipientCount !== 0,
    // Sealing an EXISTING conversation, which an operator can do without any
    // up-front recipient list — the member is a recipient by definition.
    canSealExisting: status === 'ready' && Boolean(identity?.publicKey),
    attachThread,
    unlock,
    hasKey,
    openBody,
    openRows,
    openPreview,
    sealReply,
    beginThread,
    adoptThread,
    rewrapTo,
    buildShares,
    loadRecipients,
    forgetIdentity,
    resetIdentity,
  }), [
    status,
    identity,
    reason,
    supported,
    replacedKeyId,
    recoveryAvailable,
    recipientCount,
    attachThread,
    unlock,
    hasKey,
    openBody,
    openRows,
    openPreview,
    sealReply,
    beginThread,
    adoptThread,
    rewrapTo,
    buildShares,
    loadRecipients,
    forgetIdentity,
    resetIdentity,
  ]);
}

/**
 * Accept a recipient list in any of the three shapes the endpoints return —
 * a bare array, `{ recipients }` or `{ operators }` — so the member and admin
 * callers do not have to remember which one they are talking to.
 */
function toRecipientList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.recipients)) return payload.recipients;
  if (Array.isArray(payload?.operators)) return payload.operators;
  return [];
}

