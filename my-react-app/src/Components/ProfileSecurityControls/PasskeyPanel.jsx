/**
 * Passkeys — the management panel on the security page.
 *
 * ── Why passkeys are presented ABOVE the authenticator app ────────────────
 *
 * Not as a preference. A passkey is phishing-resistant in a way a 6-digit code
 * is not: the credential is bound to this site by the authenticator and cannot
 * be replayed against a lookalike domain, whereas a code typed into a fake page
 * is just a code. Saying so plainly is the whole point — a security page that
 * ranks a weaker method first, or labels them all "2FA", teaches people the
 * wrong thing.
 *
 * The strength ordering the copy follows:
 *   passkey    strong / phishing-resistant
 *   recovery   one-time, for a lost device
 *   TOTP       strong against a stolen password, phishable
 *   email OTP  recovery only, and it does not protect the mailbox it lands in
 *
 * ── What is enforced on the server, not here ──────────────────────────────
 *
 * Adding and removing a passkey both require a step-up token, and the server
 * refuses to remove the last way an account can verify itself. Neither is
 * re-implemented in this file: the button opens the step-up dialog, and a 409
 * from the server is shown verbatim. A client-side "are you sure?" is a
 * courtesy, not a control.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addPasskey,
  getPasskeys,
  isPasskeySupported,
  removePasskey,
  renamePasskey,
} from '../../api';
import './PasskeyPanel.css';

const DEFAULT_NAME = 'Passkey';

/** "3 days ago" / "on 12 Mar 2026" — the shape the rest of the page uses. */
function when(iso) {
  if (!iso) return 'Never used';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Never used';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 1) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months} month${months === 1 ? '' : 's'} ago`;
  }
  return `on ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

const absolute = (iso) => (iso
  ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  : '—');

export default function PasskeyPanel({ onRequireStepUp, onChanged }) {
  const [passkeys, setPasskeys] = useState([]);
  const [supported] = useState(isPasskeySupported);
  const [serverAvailable, setServerAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(null);
  const [draftName, setDraftName] = useState('');
  const mounted = useRef(true);

  // Re-armed on every mount, not just cleared on unmount: React runs
  // mount -> cleanup -> mount (StrictMode in dev, and any real remount), and a
  // version that only ever set the flag to `false` left it false for the rest
  // of the page's life — so every response was discarded before it could reach
  // setState and the panel reported "no passkeys" for an account that has some.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await getPasskeys();
      if (!mounted.current) return;
      setPasskeys(data.passkeys || []);
      setServerAvailable(data.supported !== false);
      setLoadFailed(false);
    } catch {
      // "We could not load" must never render as "you have none": a panel that
      // reports a confident negative from a read that failed is worse than one
      // that says nothing.
      if (mounted.current) setLoadFailed(true);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  // Deferred a tick so the fetch is not dispatched synchronously from the
  // effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  const add = () => {
    setError('');
    setNotice('');
    // Adding an authenticator method is a security change, so it goes through
    // the same confirm-it-is-you step as everything else on this page.
    onRequireStepUp?.({
      reason: 'Adding a passkey lets a new device sign in to your account without your password, so we need to confirm it is you.',
      action: async (stepUp) => {
        setBusy('add');
        try {
          const res = await addPasskey(DEFAULT_NAME, stepUp);
          // null means a stale-chunk self-heal scheduled a reload, so the
          // WebAuthn SDK never loaded. The page is being replaced — showing a
          // notice or an error here would flash over a working screen.
          if (!mounted.current || !res) return;
          setNotice(res.message || 'Passkey added.');
          await load();
          onChanged?.();
        } catch (err) {
          if (mounted.current) setError(describeCeremonyError(err));
        } finally {
          if (mounted.current) setBusy('');
        }
      },
    });
  };

  const startRename = (p) => {
    setEditing(p.id);
    setDraftName(p.name || '');
    setError('');
  };

  const saveRename = async (id) => {
    const name = draftName.trim();
    if (!name) { setError('Enter a name for this passkey.'); return; }
    setBusy(id);
    try {
      await renamePasskey(id, name);
      if (!mounted.current) return;
      setEditing(null);
      await load();
    } catch (err) {
      if (mounted.current) setError(err.message || 'Could not rename that passkey.');
    } finally {
      if (mounted.current) setBusy('');
    }
  };

  const remove = (p) => {
    setError('');
    setNotice('');
    onRequireStepUp?.({
      reason: `Removing "${p.name || DEFAULT_NAME}" takes away a way to sign in, so we need to confirm it is you.`,
      action: async (stepUp) => {
        setBusy(p.id);
        try {
          await removePasskey(p.id, stepUp);
          if (!mounted.current) return;
          setNotice('Passkey removed.');
          await load();
          onChanged?.();
        } catch (err) {
          // LAST_STRONG_METHOD is the server refusing to leave the account with
          // a password and nothing else. Shown as-is: the fix is to add another
          // way in, not to retry harder.
          if (mounted.current) setError(err.message || 'Could not remove that passkey.');
        } finally {
          if (mounted.current) setBusy('');
        }
      },
    });
  };

  const unavailable = !supported || !serverAvailable;

  return (
    <section className="psc-card" aria-labelledby="psc-passkeys-title">
        <header className="psc-card__head">
          <h3 className="psc-card__title" id="psc-passkeys-title">
            <span className="psc-card__icon psc-card__icon--shield" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <path d="m9 12 2 2 4-4" />
              </svg>
            </span>
            Passkeys
          </h3>
          <span className="psc-badge psc-badge--on">Strong</span>
        </header>

        <p className="psc-card__lede">
          Phishing-resistant. A passkey is tied to this website by your device, so it cannot be
          reused on a fake copy of the sign-in page — the one attack a 6-digit code does not stop.
        </p>

        {error && <p className="psc-alert psc-alert--error" role="alert">{error}</p>}
        {notice && <p className="psc-alert psc-alert--ok" role="status">{notice}</p>}

        {unavailable ? (
          <p className="psc-note psc-note--warn">
            {!supported
              ? 'This browser cannot create passkeys. Chrome, Edge, Safari and Firefox on a phone, laptop or security key all can.'
              : 'Passkeys are not available on this server yet. An administrator needs to set the WebAuthn domain and origin.'}
          </p>
        ) : loading ? (
          <p className="psc-muted">Loading…</p>
        ) : loadFailed ? (
          <>
            <p className="psc-alert psc-alert--error" role="alert">
              We could not load your passkeys, so this list may be out of date.
            </p>
            <button type="button" className="psc-btn psc-btn--outline psc-btn--sm" onClick={load}>Try again</button>
          </>
        ) : passkeys.length === 0 ? (
          <p className="psc-muted">
            No passkeys yet. Adding one means this device can sign in without your password.
          </p>
        ) : (
          <ul className="psc-devices">
            {passkeys.map((p) => (
              <li key={p.id} className="psc-device">
                <div className="psc-device__main">
                  {editing === p.id ? (
                    <span className="psc-rename">
                      <input
                        className="psc-input psc-input--inline"
                        value={draftName}
                        maxLength={60}
                        autoFocus
                        aria-label="Passkey name"
                        onChange={(e) => setDraftName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); void saveRename(p.id); }
                          if (e.key === 'Escape') setEditing(null);
                        }}
                      />
                      <button
                        type="button"
                        className="psc-btn psc-btn--primary psc-btn--sm"
                        disabled={busy === p.id}
                        onClick={() => saveRename(p.id)}
                      >
                        {busy === p.id ? 'Saving…' : 'Save'}
                      </button>
                      <button type="button" className="psc-btn psc-btn--ghost psc-btn--sm" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="psc-device__label">
                      {p.name}
                      {p.backedUp && <span className="psc-chip">Synced</span>}
                      {p.deviceType === 'singleDevice' && <span className="psc-chip">This device only</span>}
                    </span>
                  )}
                  <span className="psc-device__meta">
                    {p.device}
                    {p.transports?.includes('hybrid') ? ' · available on nearby devices' : ''}
                  </span>
                  <span className="psc-device__times" title={`Created ${absolute(p.createdAt)} · Last used ${absolute(p.lastUsedAt)}`}>
                    Created {when(p.createdAt)} · Last used {when(p.lastUsedAt)}
                  </span>
                </div>
                {editing !== p.id && (
                  <span className="psc-device__actions">
                    <button
                      type="button"
                      className="psc-btn psc-btn--outline psc-btn--sm"
                      onClick={() => startRename(p)}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="psc-btn psc-btn--danger-ghost psc-btn--sm"
                      disabled={busy === p.id}
                      onClick={() => remove(p)}
                    >
                      {busy === p.id ? 'Removing…' : 'Remove'}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {!unavailable && (
          <button
            type="button"
            className="psc-btn psc-btn--primary psc-btn--mt"
            disabled={busy === 'add'}
            onClick={add}
          >
            {busy === 'add' ? 'Waiting for your device…' : '+ Add a passkey'}
          </button>
        )}

        {passkeys.length > 0 && (
          <p className="psc-note">
            A passkey is used automatically when it can. You can rename it to say which device it is.
          </p>
        )}
      </section>
  );
}

/**
 * Turn a WebAuthn DOMException into something a person can act on.
 *
 * `NotAllowedError` covers both "you dismissed the prompt" and "the operation
 * timed out", and neither is a failure worth an error banner. Everything else
 * gets the server's own wording, which never names the internal check that
 * failed.
 */
function describeCeremonyError(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError') {
    return 'No passkey was added. If you dismissed the prompt, try again when you are ready.';
  }
  if (name === 'InvalidStateError') {
    return 'This device already has a passkey for SuppliWise.';
  }
  if (name === 'SecurityError' || name === 'NotSupportedError') {
    return 'This device cannot create a passkey here. Try a phone, a computer with Windows Hello or Mac Touch ID, or a security key.';
  }
  if (name === 'AbortError') return 'The passkey prompt was closed.';
  return err?.message || 'Could not complete the passkey request.';
}
