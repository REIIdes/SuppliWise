import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import {
  isPasskeySupported,
  recoverWithAuthenticator,
  recoverWithPasskey,
  recoverWithRecoveryCode,
  requestPasswordReset,
  requestRecoveryEmailReset,
} from '../api';
import './PasswordReset.css';

// Matches the client's own address check. The server validates independently —
// this exists only so a typo is caught before a round trip, never as a
// substitute for it.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
// Mirror of the per-account cooldown in server/utils/passwordReset.js. The
// server suppresses rather than rejects while cooling down (a 429 here would
// tell an enumerator the address has an account), so the client is the only
// place the wait can be communicated — which makes this timer load-bearing,
// not decoration.
const RESEND_COOLDOWN_SECONDS = 60;

function Icon({ name }) {
  if (name === 'mail') {
    return (
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
      </svg>
    );
  }
  if (name === 'check') {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    );
  }
  if (name === 'error') {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
    );
  }
  if (name === 'back') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 12H5M12 19l-7-7 7-7" />
      </svg>
    );
  }
  // ── Alternative recovery proofs ────────────────────────────────────────
  if (name === 'key') {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m21 2-2 2m-7.6 7.6a5.5 5.5 0 1 0-7.8 7.8 5.5 5.5 0 0 0 7.8-7.8Zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3" />
      </svg>
    );
  }
  if (name === 'phone') {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="5" y="2" width="14" height="20" rx="2" />
        <path d="M12 18h.01" />
      </svg>
    );
  }
  if (name === 'fingerprint') {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 11a2 2 0 0 1 2 2c0 2.5-.5 5-2 7" />
        <path d="M8.5 20c1.5-2 2.5-4.5 2.5-7a1 1 0 0 1 2 0c0 1.2-.1 2.4-.4 3.5" />
        <path d="M5.5 17.5A9 9 0 0 0 7 12a5 5 0 0 1 10 0c0 1.6-.1 3.2-.4 4.7" />
        <path d="M3.5 15.5A11 11 0 0 0 4 12a8 8 0 0 1 3-6.2" />
      </svg>
    );
  }
  if (name === 'shield') {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    );
  }
  return null;
}

/**
 * The address check, as a pure function.
 *
 * Returns the message to show, or '' when the address is acceptable. Kept out
 * of the submit handler so the field can validate itself live while typing —
 * the server still validates independently, and nothing here is a substitute.
 */
function emailProblem(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return 'Please enter your email address.';
  if (!EMAIL_REGEX.test(trimmed)) return 'Please enter a valid email address (e.g. name@example.com).';
  return '';
}

/**
 * The alternative proofs, strongest first.
 *
 * The order is the ranking, and it is the reason a user should be able to pick
 * any of them: a passkey is a signature from a key that never leaves the
 * authenticator, a recovery code is a high-entropy single-use secret, an
 * authenticator code is a time-limited number, and a recovery email is still
 * just possession of a mailbox — so it is last.
 *
 * `needsEmail: false` is the passkey's, and it is not a detail. A passkey
 * ceremony identifies the account from the credential the authenticator returns,
 * so asking for an address first would only create a way to probe which
 * addresses have accounts.
 */
const ALTERNATIVE_METHODS = [
  {
    id: 'passkey',
    label: 'Passkey',
    icon: 'fingerprint',
    blurb: 'Confirm with the fingerprint, Face ID or PIN already on this device.',
    needsEmail: false,
  },
  {
    id: 'recovery-code',
    label: 'Recovery code',
    icon: 'key',
    blurb: 'Use one of the spare codes you saved when you set up two-factor authentication.',
    needsEmail: true,
  },
  {
    id: 'authenticator',
    label: 'Authenticator app',
    icon: 'phone',
    blurb: 'Enter the 6-digit code from Google Authenticator or a similar app.',
    needsEmail: true,
  },
  {
    id: 'recovery-email',
    label: 'Backup email',
    icon: 'shield',
    blurb: 'Send the link to the secondary address on your account instead.',
    needsEmail: true,
  },
];

/** Recovery codes are printed as XXXXX-XXXXX. */
const RECOVERY_CODE_REGEX = /^[A-Z0-9]{5}-[A-Z0-9]{5}$/;

/**
 * Normalise a recovery code the way a person would type it.
 *
 * The dash is added by us and stripped again server-side (`BackupCode.normalise`
 * removes every non-alphanumeric character), so pasting a code the user copied
 * with spaces, no dash, or all lowercase has to work rather than being rejected
 * over formatting.
 *
 * The length is capped at ten SYMBOLS and the dash is re-inserted afterwards,
 * which is the part that used to be wrong: slicing to ten and returning early
 * skipped the dash, so a long paste produced `ABCDEFGHIJ` — a value that can
 * never match the `XXXXX-XXXXX` check below and that the user had no way to
 * correct short of clearing the field.
 */
function tidyRecoveryCode(value) {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  return raw.length > 5 ? `${raw.slice(0, 5)}-${raw.slice(5)}` : raw;
}

function ForgotPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  // Pre-filled from the sign-in page, so a user who misspelled their address
  // can correct it here instead of starting over.
  const [email, setEmail] = useState(() => (searchParams.get('email') || '').trim().slice(0, 254));
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState('');
  // `error` carries only what the SERVER refused. A mistyped address is a
  // field-level message shown under the input, not a banner above the form —
  // the two used to compete for the same slot and the user could not tell which
  // one their text had landed in.
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  // Flipped by the first submit or the first blur. Until then the field stays
  // quiet, because telling someone their half-typed address is invalid before
  // they have finished typing it is just noise.
  const [touched, setTouched] = useState(false);

  // ── Alternative proofs ─────────────────────────────────────────────────
  // Collapsed by default. The emailed link is the right answer for almost
  // everyone and burying it under four other options would make the common case
  // harder, not easier.
  const [showAlternatives, setShowAlternatives] = useState(false);
  // null until someone picks one, so the panel can stay closed but expand in
  // place rather than swapping the whole form out.
  const [method, setMethod] = useState(null);
  const [secret, setSecret] = useState('');
  const [methodBusy, setMethodBusy] = useState(false);
  // Separate from `error`: these are per-method failures with their own retry
  // budget, and mixing them into the banner above the email field would blame
  // the address for a code that was wrong.
  const [methodError, setMethodError] = useState('');
  const [recoveryNote, setRecoveryNote] = useState('');

  const passkeyAvailable = isPasskeySupported();
  // Surfaced, not filtered. Whether an account HAS a passkey or codes is
  // exactly the thing the server refuses to disclose — a list that silently
  // dropped unavailable methods would turn the panel back into an enumeration
  // oracle, and the client would learn a fact the API deliberately hides.
  const availableMethods = ALTERNATIVE_METHODS;

  const trimmed = email.trim();
  const fieldProblem = trimmed ? emailProblem(email) : '';
  // Only surfaced once the field has been visited, so an empty untouched form
  // does not open with a red border and an error.
  const showProblem = touched && !loading && fieldProblem;
  const addressLooksValid = EMAIL_REGEX.test(trimmed);

  // Held in a ref, not state: resetting it must not re-render. The interval is
  // cleared on unmount so a countdown cannot outlive the page and keep ticking
  // against a dead component.
  const timerRef = useRef(null);
  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  const startCooldown = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setCooldown(RESEND_COOLDOWN_SECONDS);
    timerRef.current = setInterval(() => {
      setCooldown((seconds) => {
        if (seconds <= 1) {
          clearInterval(timerRef.current);
          timerRef.current = null;
          return 0;
        }
        return seconds - 1;
      });
    }, 1000);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setTouched(true);

    // A client-side problem stops here and is reported by the field itself, so
    // the banner stays clear for the failures only the server can know about.
    if (emailProblem(email)) {
      setError('');
      return;
    }

    setError('');
    setLoading(true);
    try {
      const data = await requestPasswordReset(trimmed);
      setSent(true);
      setMessage(data?.message || 'If an account exists for that address, a reset link is on its way.');
      startCooldown();
    } catch (err) {
      setError(err.message || 'We could not send your reset link. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Take a grant the server just minted and walk the user into the reset form.
   *
   * The token goes in the URL because that is the ONE screen that knows how to
   * redeem a grant — the same place the emailed link arrives, so there is a
   * single redemption path rather than one per recovery method. It is a
   * credential, so it is replaced out of the address bar immediately after:
   * `replaceState` rewrites the entry without reloading, which keeps the token
   * out of history and out of any Referer the next navigation could send.
   */
  const continueToReset = (token) => {
    if (!token) return;
    const target = `/reset-password?token=${encodeURIComponent(token)}`;
    navigate(target, { replace: true });
    if (typeof window !== 'undefined' && window.history && window.history.replaceState) {
      window.history.replaceState(null, '', '/reset-password');
    }
  };

  const chooseMethod = (next) => {
    setMethod((current) => (current === next ? null : next));
    setMethodError('');
    setRecoveryNote('');
    setSecret('');
  };

  /**
   * Run whichever proof the user picked.
   *
   * All four end the same way — a `resetToken` handed to `continueToReset` —
   * except the recovery email, which delivers a link instead of returning a
   * grant, so it reports what happened and stops.
   *
   * A 401 is deliberately shown verbatim and nothing more. The server returns
   * one message for every failure so that this screen cannot become a probe for
   * which addresses are registered; adding any local "that account has no
   * codes"-style commentary would undo that on the client side.
   */
  const handleMethodSubmit = async (event) => {
    event.preventDefault();
    if (!method || methodBusy) return;

    const chosen = ALTERNATIVE_METHODS.find((m) => m.id === method);
    if (!chosen) return;

    // The passkey names the account itself, so it never asks for an address.
    // Every other method needs one, and a missing address is checkable here
    // without a round trip.
    if (chosen.needsEmail && emailProblem(email)) {
      setTouched(true);
      setMethodError('Enter your email address above first, then choose your recovery method.');
      return;
    }

    if (method === 'recovery-code' && !RECOVERY_CODE_REGEX.test(secret.trim().toUpperCase())) {
      setMethodError('Enter a recovery code in the form XXXXX-XXXXX.');
      return;
    }
    if (method === 'authenticator' && !/^\d{6,8}$/.test(secret.trim())) {
      setMethodError('Enter the 6-digit code from your authenticator app.');
      return;
    }

    setMethodBusy(true);
    setMethodError('');
    setRecoveryNote('');
    try {
      if (method === 'passkey') {
        const data = await recoverWithPasskey();
        // A null return means a reload was scheduled; navigating now would race
        // it and lose the grant the server just minted.
        if (!data) return;
        continueToReset(data.resetToken);
        return;
      }
      if (method === 'recovery-code') {
        const data = await recoverWithRecoveryCode(trimmed, secret.trim());
        continueToReset(data.resetToken);
        // Only reached if the page somehow survived the navigation above.
        setRecoveryNote(`Recovery code accepted. ${data.remainingCodes ?? ''} codes left after this one.`);
        return;
      }
      if (method === 'authenticator') {
        const data = await recoverWithAuthenticator(trimmed, secret.trim());
        continueToReset(data.resetToken);
        return;
      }
      const data = await requestRecoveryEmailReset(trimmed);
      setRecoveryNote(data?.message || 'If that account has a backup email, a link is on its way.');
    } catch (err) {
      // A dismissed passkey prompt is a choice, not a failure — stay silent.
      if (err?.cancelled) return;
      setMethodError(err.message || 'That did not work. Please try again.');
    } finally {
      setMethodBusy(false);
    }
  };

  // ── Sent ───────────────────────────────────────────────────────────────
  if (sent) {
    return (
      <div className="pwreset-page">
        <Navbar />
        <main className="pwreset-card">
          <div className="pwreset-badge" aria-hidden="true"><Icon name="mail" /></div>
          <h1 className="pwreset-title">Check your email</h1>
          <p className="pwreset-subtitle">{message}</p>

          <div className="pwreset-inbox">
            <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--pw-ink)' }}>We sent the link to</p>
            <span className="pwreset-inbox-address">{email.trim()}</span>
            <p className="pwreset-inbox-note">
              The link works once and expires in 30 minutes.<br />
              Nothing arrived? Look in your spam folder, use another way to recover, or send another.
            </p>
          </div>

          <button
            type="button"
            className="pwreset-btn pwreset-btn-secondary"
            onClick={handleSubmit}
            disabled={loading || cooldown > 0}
          >
            {loading && <span className="pwreset-btn-spinner" aria-hidden="true" />}
            {loading
              ? 'Sending…'
              : cooldown > 0
                ? `Send another link (${cooldown}s)`
                : 'Send another link'}
          </button>

          {/* The person who most needs an alternative is the one whose mail never
              arrived, so this is offered HERE as well as on the form — reaching it
              must not require going back and starting over. */}
          <button
            type="button"
            className="pwreset-alt-toggle"
            onClick={() => { setSent(false); setShowAlternatives(true); }}
          >
            <Icon name="key" />
            Can&apos;t get the email? Use another method
          </button>

          <Link className="pwreset-back" to="/login">
            <Icon name="back" />
            Back to sign in
          </Link>

          <p className="pwreset-footnote">
            For your security we show the same confirmation whether or not an account exists.
          </p>
        </main>
      </div>
    );
  }

  // ── Ask ────────────────────────────────────────────────────────────────
  return (
    <div className="pwreset-page">
      <Navbar />
      <main className="pwreset-card">
        <div className="pwreset-badge" aria-hidden="true"><Icon name="mail" /></div>
        <h1 className="pwreset-title">Reset your password</h1>
        <p className="pwreset-subtitle">
          Enter the email address on your account and we&apos;ll send you a link to choose a new password.
        </p>

        {/* Server-side refusals only. See `error` above. */}
        {error && (
          <div className="pwreset-alert is-error" role="alert">
            <Icon name="error" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <div className="pwreset-field">
            <label htmlFor="pwreset-email">Email address</label>
            <div className={`pwreset-lead${addressLooksValid && !showProblem ? ' pwreset-lead--ok' : ''}`}>
              <span className="pwreset-lead__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                </svg>
              </span>
              <input
                id="pwreset-email"
                name="email"
                type="email"
                className="pwreset-input"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setError(''); }}
                onBlur={() => setTouched(true)}
                placeholder="you@example.com"
                autoComplete="email"
                // Not readOnly: browsers do not offer a password-manager entry
                // for a readOnly field, which is exactly what we want here.
                readOnly={false}
                disabled={loading}
                maxLength={254}
                aria-invalid={showProblem ? 'true' : undefined}
                aria-describedby={showProblem ? 'pwreset-email-error' : undefined}
                autoFocus
              />
              {/* Confirms the address parses as you type, so a typo is caught
                  before the round trip rather than by the server's silence. */}
              {addressLooksValid && !showProblem && !loading && (
                <span className="pwreset-lead__ok" aria-hidden="true"><Icon name="check" /></span>
              )}
            </div>
            {showProblem && (
              <p className="pwreset-field-error" id="pwreset-email-error">
                <Icon name="error" />
                {showProblem}
              </p>
            )}
          </div>

          <button type="submit" className="pwreset-btn pwreset-btn-primary" disabled={loading}>
            {loading && <span className="pwreset-btn-spinner" aria-hidden="true" />}
            {loading ? 'Sending…' : 'Send reset link'}
          </button>
        </form>

        {/* ── Alternative proofs ───────────────────────────────────────────
            Hidden behind a toggle on purpose: emailing a link is the right
            answer for almost everyone, and four more options above the fold
            would make the common case harder, not easier. */}
        <div className="pwreset-alt">
          <button
            type="button"
            className="pwreset-alt-toggle"
            aria-expanded={showAlternatives}
            onClick={() => {
              setShowAlternatives((v) => !v);
              setMethodError('');
              setRecoveryNote('');
            }}
          >
            <Icon name="key" />
            {showAlternatives ? 'Hide other ways to recover' : 'No email? Try another way'}
          </button>

          {showAlternatives && (
            <div className="pwreset-alt-panel">
              <p className="pwreset-alt-intro">
                If you cannot reach the mailbox on the account, you can prove it a different
                way. Each one opens the same reset form.
              </p>

              {/* A radiogroup, not four separate forms: one proof is used at a
                  time, and this is a choice between them. Native buttons rather
                  than a custom widget so keyboard and screen-reader behaviour is
                  the platform's. */}
              <div className="pwreset-methods" role="radiogroup" aria-label="Choose a recovery method">
                {availableMethods.map((option) => {
                  const selected = method === option.id;
                  const unavailable = option.id === 'passkey' && !passkeyAvailable;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`pwreset-method${selected ? ' is-selected' : ''}${unavailable ? ' is-unavailable' : ''}`}
                      onClick={() => chooseMethod(option.id)}
                      disabled={methodBusy}
                    >
                      <span className="pwreset-method__icon" aria-hidden="true"><Icon name={option.icon} /></span>
                      <span className="pwreset-method__text">
                        <strong>{option.label}</strong>
                        <span>{unavailable ? 'Not available in this browser.' : option.blurb}</span>
                      </span>
                    </button>
                  );
                })}
              </div>

              {method && (
                <form className="pwreset-alt-form" onSubmit={handleMethodSubmit} noValidate>
                  <div className="pwreset-field">
                    <label htmlFor="pwreset-secret">
                      {method === 'recovery-code' ? 'Recovery code' : method === 'authenticator' ? 'Authenticator code' : 'Confirm with your passkey'}
                    </label>

                    {/* The passkey has no text field at all — the button IS the
                        input, and the browser's own prompt does the rest. */}
                    {method !== 'passkey' && (
                      <input
                        id="pwreset-secret"
                        name="secret"
                        type="text"
                        className="pwreset-input"
                        value={secret}
                        onChange={(e) => {
                          setSecret(method === 'recovery-code' ? tidyRecoveryCode(e.target.value) : e.target.value.replace(/[^0-9]/g, '').slice(0, 8));
                          setMethodError('');
                        }}
                        placeholder={method === 'recovery-code' ? 'XXXXX-XXXXX' : '000000'}
                        autoComplete="one-time-code"
                        inputMode={method === 'authenticator' ? 'numeric' : 'text'}
                        maxLength={method === 'recovery-code' ? 11 : 8}
                        disabled={methodBusy}
                        autoFocus
                      />
                    )}

                    {method !== 'passkey' && (
                      <p className="pwreset-hint">
                        {method === 'recovery-code'
                          ? 'Each code works once. Using one here still lets you set a new password.'
                          : 'Codes change every 30 seconds, so type the current one.'}
                      </p>
                    )}
                  </div>

                  {methodError && (
                    <div className="pwreset-alert is-error" role="alert">
                      <Icon name="error" />
                      <span>{methodError}</span>
                    </div>
                  )}

                  {recoveryNote && (
                    <div className="pwreset-alert is-success" role="status">
                      <Icon name="check" />
                      <span>{recoveryNote}</span>
                    </div>
                  )}

                  <button type="submit" className="pwreset-btn pwreset-btn-primary" disabled={methodBusy}>
                    {methodBusy && <span className="pwreset-btn-spinner" aria-hidden="true" />}
                    {methodBusy
                      ? 'Checking…'
                      : method === 'passkey'
                        ? 'Use my passkey'
                        : method === 'recovery-email'
                          ? 'Send to my backup email'
                          : 'Continue'}
                  </button>
                </form>
              )}

              <p className="pwreset-footnote">
                We ask the same question whichever way you choose, so we can&apos;t tell you
                here whether an account exists or which of these it has set up.
              </p>
            </div>
          )}
        </div>

        <Link className="pwreset-back" to="/login">
          <Icon name="back" />
          Back to sign in
        </Link>
      </main>
    </div>
  );
}

export default ForgotPassword;
