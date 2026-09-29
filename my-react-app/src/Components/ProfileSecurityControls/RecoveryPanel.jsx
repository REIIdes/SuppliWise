/**
 * Recovery & Authentication — backup recovery codes and the recovery email.
 *
 * Both sit behind StepUpDialog. Both are places where a stolen session could
 * otherwise cause lasting harm: a recovery code is a working credential, and a
 * recovery email is the address the owner would be warned through.
 *
 * A note on where each fact comes from, because getting it wrong is what made
 * these cards look broken:
 *
 *   • "Is two-factor on?" comes from the PARENT (ProfilePage), which already
 *     owns that state and keeps it current after the setup and disable modals.
 *     It is passed in as `twoFactorEnabled`. The Recovery Codes card used to
 *     read it from the security summary instead — a second, independent read
 *     that only refreshed when a card inside this file changed something. Since
 *     2FA is turned on from OUTSIDE this file, the two disagreed: the card
 *     kept saying "available once two-factor authentication is on" on an
 *     account that had just turned it on, with no buttons to press.
 *   • "How many codes are left?" comes from the summary, which is the only
 *     read that knows about redemptions made at sign-in.
 */
import { useEffect, useRef, useState } from 'react';
import {
  generateBackupCodes, invalidateBackupCodes,
  requestRecoveryEmail, verifyRecoveryEmail, removeRecoveryEmail,
} from '../../api';
import './RecoveryPanel.css';

// Clipboard writes are refused in plenty of real contexts (no permission, an
// insecure origin, a browser that only supports the legacy API) and a recovery
// code the user could not copy is a recovery code they have to retype by hand.
// Fall back to a selectable, focused textarea rather than losing the only copy.
const copyText = async (text) => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the manual path */ }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
};

/** Codes as plain text, one per line, ready to paste into a password manager. */
const asText = (codes) => codes.join('\n');

/**
 * The one-and-only view of a freshly minted set.
 *
 * Split out from the card, deliberately. This block is the only place in the
 * product where a working credential is ever rendered, so it has to be
 * checkable on its own: the card's other states are reachable from props, but
 * this one is internal state, and a view that can only be reached by clicking
 * through a live session is a view nobody tests. Splitting it out means the
 * warnings, the copy affordance and the dismiss control can be asserted
 * directly — see RecoveryPanel.test.js.
 */
export function RecoveryCodesPanel({ codes, copied, onCopy, onDone }) {
  return (
    <div className="psc-codes" role="status">
      <p className="psc-codes__warn">
        <strong>Save these now.</strong> Each code works once, and they cannot be shown again.
      </p>
      <ul className="psc-codes__list">
        {codes.map((c, i) => <li key={`${i}-${c}`}><code>{c}</code></li>)}
      </ul>
      <div className="psc-btn-row">
        <button type="button" className="psc-btn psc-btn--ghost" onClick={onCopy}>
          {copied ? 'Copied' : 'Copy all codes'}
        </button>
        <button type="button" className="psc-btn psc-btn--primary" onClick={onDone}>
          I&apos;ve saved them
        </button>
      </div>
      {!copied && (
        <p className="psc-hint">
          Keep them somewhere other than this device — a password manager, a locked note, or a printout.
        </p>
      )}
    </div>
  );
}

export function BackupCodesCard({
  summary,
  summaryFailed = false,
  twoFactorEnabled = false,
  onRequireStepUp,
  onChanged,
  onEnableTwoFactor,
  onRetry,
}) {
  const [codes, setCodes] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(null);

  const remaining = summary?.backupCodes?.remaining ?? 0;
  const total = summary?.backupCodes?.total ?? 0;
  // The count is only a FACT once the summary has actually arrived. Before it
  // has — still loading, or the read failed — `remaining` is a 0 that means
  // "unknown", and rendering it as "None" / "You have no recovery codes" tells
  // the user something false about their account. Those are separate states and
  // they have to look different.
  const countUnknown = !summary;

  // Clear the copy confirmation on unmount so the timer cannot set state on a
  // component that is gone.
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const run = async (fn) => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  // Regenerating destroys the codes the user is currently relying on, and the
  // server cannot show them again. That deserves a second beat, not a click.
  const askToGenerate = () => {
    setError('');
    if (remaining > 0 && !confirming) { setConfirming(true); return; }
    setConfirming(false);
    onRequireStepUp({
      reason: remaining > 0
        ? 'Creating new codes permanently invalidates the ones you have now, so we need to confirm it is you.'
        : 'Recovery codes are working credentials for your account, so we need to confirm it is you.',
      action: async (stepUp) => run(async () => {
        const res = await generateBackupCodes(stepUp);
        setCopied(false);
        // A malformed response would render an empty list the user is then
        // told to save. Treat it as a failure rather than show nothing.
        if (!Array.isArray(res?.codes) || res.codes.length === 0) {
          throw new Error('The server did not return any recovery codes. Please try again.');
        }
        setCodes(res.codes);
        onChanged?.();
      }),
    });
  };

  const invalidate = () => {
    setError('');
    onRequireStepUp({
      reason: 'Invalidating recovery codes stops them working, so we need to confirm it is you first.',
      action: async (stepUp) => run(async () => {
        const res = await invalidateBackupCodes(stepUp);
        setCodes(null);
        setConfirming(false);
        setNotice(res?.message || 'All recovery codes have been invalidated.');
        onChanged?.();
      }),
    });
  };

  const copy = async () => {
    const ok = await copyText(asText(codes || []));
    setCopied(ok);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 2500);
  };

  // ── 2FA is off: the card is a dead end, so give it a way out ───────────
  // The server refuses to mint codes without a second factor (that is the
  // point of a recovery code), and the previous version simply said so and
  // rendered no controls. The one action that unblocks the user is right here
  // in the Two-Factor card directly above, so the Recovery Codes card points
  // at it rather than leaving them to go looking.
  if (!twoFactorEnabled) {
    return (
      <section className="psc-card" aria-labelledby="psc-backup-title">
        <header className="psc-card__head">
          <h3 className="psc-card__title" id="psc-backup-title">
            <span className="psc-card__icon psc-card__icon--key" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 2l-2 2m-7.6 7.6a5 5 0 1 1-7.1 7.1 5 5 0 0 1 7.1-7.1zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3" />
              </svg>
            </span>
            Recovery Codes
          </h3>
        </header>

        <p className="psc-card__lede">
          Recovery codes are single-use codes that let you back in if you lose your
          authenticator. They are only available once two-factor authentication is on.
        </p>

        {onEnableTwoFactor && (
          <div className="psc-btn-row">
            <button type="button" className="psc-btn psc-btn--primary" onClick={onEnableTwoFactor} disabled={busy}>
              Turn on two-factor authentication
            </button>
            <span className="psc-hint">Two-Factor Authentication is the card above.</span>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="psc-card" aria-labelledby="psc-backup-title">
      <header className="psc-card__head">
        <h3 className="psc-card__title" id="psc-backup-title">
          <span className="psc-card__icon psc-card__icon--key" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2l-2 2m-7.6 7.6a5 5 0 1 1-7.1 7.1 5 5 0 0 1 7.1-7.1zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3" />
            </svg>
          </span>
          Recovery Codes
        </h3>
        <span className={`psc-badge${remaining > 0 ? ' psc-badge--on' : ''}`}>
          {countUnknown
            ? 'Loading…'
            : total > 0 ? `${remaining} of ${total} left` : (remaining > 0 ? `${remaining} left` : 'None')}
        </span>
      </header>

      <p className="psc-card__lede">
        Single-use codes that let you sign in if you lose your authenticator. Each code works once.
      </p>

      {error && <p className="psc-alert psc-alert--error" role="alert">{error}</p>}
      {notice && <p className="psc-alert psc-alert--ok" role="status">{notice}</p>}

      {/* A failed read is reported as a failure, not as an account with no
          codes. Silently showing "None" here is what made this card look
          broken instead of unreachable. */}
      {summaryFailed && !summary && (
        <p className="psc-alert psc-alert--error" role="alert">
          We could not load your recovery codes.{' '}
          {onRetry && (
            <button type="button" className="psc-btn psc-btn--ghost" onClick={onRetry}>Try again</button>
          )}
        </p>
      )}

      {codes && (
        <RecoveryCodesPanel
          codes={codes}
          copied={copied}
          onCopy={copy}
          onDone={() => { setCodes(null); setCopied(false); onChanged?.(); }}
        />
      )}

      {!codes && confirming && (
        <div className="psc-confirm" role="group" aria-label="Confirm replacing your recovery codes">
          <p className="psc-confirm__text">
            You have {remaining} unused {remaining === 1 ? 'code' : 'codes'}. Creating a new set
            immediately invalidates {remaining === 1 ? 'it' : 'all of them'} — they cannot be shown again.
          </p>
          <div className="psc-confirm__actions">
            <button type="button" className="psc-btn psc-btn--primary" onClick={askToGenerate} disabled={busy}>
              {busy ? 'Working…' : 'Replace my codes'}
            </button>
            <button type="button" className="psc-btn psc-btn--ghost" onClick={() => setConfirming(false)} disabled={busy}>
              Keep my codes
            </button>
          </div>
        </div>
      )}

      {!codes && !confirming && (
        <div className="psc-btn-row">
          <button type="button" className="psc-btn psc-btn--primary" onClick={askToGenerate} disabled={busy}>
            {busy ? 'Working…' : remaining > 0 ? 'Regenerate codes' : 'Create recovery codes'}
          </button>
          {remaining > 0 && (
            <button type="button" className="psc-btn psc-btn--danger-ghost" onClick={invalidate} disabled={busy}>
              Invalidate all
            </button>
          )}
        </div>
      )}

      {/* Only ever a fact once the count is known. */}
      {!countUnknown && remaining === 0 && !codes && (
        <p className="psc-note psc-note--warn">
          <strong>You have no recovery codes.</strong> If you lose your authenticator, you will
          need to use the emailed backup process to get back into this account.
        </p>
      )}
    </section>
  );
}

export function RecoveryEmailCard({ summary, onRequireStepUp, onChanged }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  // Only true while the user has explicitly asked to replace an existing
  // address. It is NOT initialised from the summary any more — see below.
  const [changing, setChanging] = useState(false);

  const current = summary?.recoveryEmail?.address || null;
  const verified = summary?.recoveryEmail?.verified === true;

  const run = async (fn) => {
    setError(''); setDone(''); setBusy(true);
    try { await fn(); } catch (err) { setError(err.message || 'Something went wrong.'); } finally { setBusy(false); }
  };

  const start = () => {
    setError('');
    setDone('');
    onRequireStepUp({
      reason: 'Adding a recovery email changes where we can warn you, so we need to confirm it is you.',
      action: async (stepUp) => run(async () => {
        await requestRecoveryEmail(email, stepUp);
        setPending(true);
      }),
    });
  };

  const confirm = () => run(async () => {
    await verifyRecoveryEmail(code);
    setPending(false); setChanging(false); setCode(''); setEmail('');
    setDone('Recovery email verified.');
    onChanged?.();
  });

  const remove = () => onRequireStepUp({
    reason: 'Removing your recovery email means we can no longer warn you there, so we need to confirm it is you.',
    action: async (stepUp) => run(async () => {
      await removeRecoveryEmail(stepUp);
      setDone('Recovery email removed.');
      onChanged?.();
    }),
  });

  const close = () => {
    setChanging(false);
    setPending(false);
    setEmail('');
    setCode('');
    setError('');
  };

  return (
    <section className="psc-card" aria-labelledby="psc-recovery-title">
      <header className="psc-card__head">
        <h3 className="psc-card__title" id="psc-recovery-title">
          <span className="psc-card__icon psc-card__icon--devices" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="5" width="20" height="14" rx="2" />
              <path d="m2 7 10 6 10-6" />
            </svg>
          </span>
          Recovery Email
        </h3>
        {current && (
          <span className={`psc-badge${verified ? ' psc-badge--on' : ''}`}>{verified ? 'Verified' : 'Unverified'}</span>
        )}
      </header>

      <p className="psc-card__lede">
        A second address we can use to warn you if your account is under pressure. It
        <strong> cannot be used to sign in</strong> and never replaces your account email.
      </p>

      {error && <p className="psc-alert psc-alert--error" role="alert">{error}</p>}
      {done && <p className="psc-alert psc-alert--ok" role="status">{done}</p>}

      {/* The saved address, with Change / Remove. */}
      {current && !pending && !changing && (
        <div className="psc-panel">
          <span className="psc-panel__label">Recovery address</span>
          <span className="psc-panel__value">{current}</span>
          {!verified && (
            <p className="psc-note psc-note--warn">
              This address has not been confirmed yet, so we cannot rely on it to warn you.
            </p>
          )}
          <div className="psc-btn-row">
            <button type="button" className="psc-btn psc-btn--ghost" onClick={() => { setChanging(true); setEmail(''); setError(''); }} disabled={busy}>
              Change
            </button>
            <button type="button" className="psc-btn psc-btn--danger-ghost" onClick={remove} disabled={busy}>
              Remove
            </button>
          </div>
        </div>
      )}

      {/* Awaiting the emailed confirmation code. */}
      {pending && (
        <div className="psc-fieldset">
          <p className="psc-rules">
            We sent a 6-digit code to <strong>{email}</strong>. It stays unverified until you enter it.
          </p>
          <label className="psc-label" htmlFor="psc-rec-code">Confirmation code</label>
          <input
            id="psc-rec-code"
            className="psc-input psc-input--otp"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(''); }}
            placeholder="000000"
            autoComplete="one-time-code"
          />
          <div className="psc-btn-row">
            <button type="button" className="psc-btn psc-btn--primary" onClick={confirm} disabled={busy || code.length !== 6}>
              {busy ? 'Verifying…' : 'Verify and save'}
            </button>
            <button type="button" className="psc-btn psc-btn--ghost" onClick={close} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* The entry form: shown whenever there is no saved address, or the user
          asked to replace one. The previous version gated this on a `mode`
          state initialised from the summary, which meant that after REMOVING
          the address `mode` was still 'set' and no branch matched — the card
          rendered a heading and a description and nothing else, with no way to
          add one back. Deriving it from the current state cannot go stale. */}
      {!pending && (!current || changing) && (
        <div className="psc-fieldset">
          <label className="psc-label" htmlFor="psc-rec-email">
            {current ? 'New recovery email address' : 'Recovery email address'}
          </label>
          <input
            id="psc-rec-email"
            className="psc-input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError(''); }}
            placeholder="name@example.com"
          />
          <div className="psc-btn-row">
            <button type="button" className="psc-btn psc-btn--primary" onClick={start} disabled={busy || !email.trim()}>
              {busy ? 'Sending…' : 'Send confirmation code'}
            </button>
            {current && (
              <button type="button" className="psc-btn psc-btn--ghost" onClick={close} disabled={busy}>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
