/**
 * Recovery & Authentication — backup recovery codes and the recovery email.
 *
 * Both sit behind StepUpDialog. Both are places where a stolen session could
 * otherwise cause lasting harm: a recovery code is a working credential, and a
 * recovery email is the address the owner would be warned through.
 */
import { useState } from 'react';
import {
  generateBackupCodes, invalidateBackupCodes,
  requestRecoveryEmail, verifyRecoveryEmail, removeRecoveryEmail,
} from '../../api';
import './RecoveryPanel.css';

export function BackupCodesCard({ summary, onRequireStepUp, onChanged }) {
  const [codes, setCodes] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const enabled = summary?.twoFactor?.enabled === true;
  const remaining = summary?.backupCodes?.remaining ?? 0;

  const run = async (fn) => {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const generate = () => onRequireStepUp({
    reason: 'Generating recovery codes gives new credentials for your account, so we need to confirm it is you.',
    action: async (stepUp) => run(async () => {
      const res = await generateBackupCodes(stepUp);
      setCodes(res.codes);
      onChanged?.();
    }),
  });

  const invalidate = () => onRequireStepUp({
    reason: 'Invalidating recovery codes stops them working, so we need to confirm it is you first.',
    action: async (stepUp) => run(async () => {
      await invalidateBackupCodes(stepUp);
      setCodes(null);
      onChanged?.();
    }),
  });

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
        {enabled && (
          <span className={`psc-badge${remaining > 0 ? ' psc-badge--on' : ''}`}>
            {remaining > 0 ? `${remaining} left` : 'None'}
          </span>
        )}
      </header>

      <p className="psc-card__lede">
        {enabled
          ? 'Single-use codes that let you sign in if you lose your authenticator. Each code works once.'
          : 'Recovery codes are available once two-factor authentication is on.'}
      </p>

      {error && <p className="psc-alert psc-alert--error" role="alert">{error}</p>}

      {codes && (
        <div className="psc-codes" role="status">
          <p className="psc-codes__warn">
            <strong>Save these now.</strong> Each code works once, and they cannot be shown again.
          </p>
          <ul className="psc-codes__list">
            {codes.map((c) => <li key={c}><code>{c}</code></li>)}
          </ul>
          <button type="button" className="psc-btn psc-btn--ghost" onClick={() => { setCodes(null); onChanged?.(); }}>
            I&apos;ve saved them
          </button>
        </div>
      )}

      {enabled && !codes && (
        <div className="psc-btn-row">
          <button type="button" className="psc-btn psc-btn--primary" onClick={generate} disabled={busy}>
            {busy ? 'Working…' : remaining > 0 ? 'Regenerate codes' : 'Create recovery codes'}
          </button>
          {remaining > 0 && (
            <button type="button" className="psc-btn psc-btn--danger-ghost" onClick={invalidate} disabled={busy}>
              Invalidate all
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function RecoveryEmailCard({ summary, onRequireStepUp, onChanged }) {
  const [mode, setMode] = useState(summary?.recoveryEmail?.address ? 'set' : 'add');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);

  const current = summary?.recoveryEmail?.address || null;
  const verified = summary?.recoveryEmail?.verified === true;

  const run = async (fn) => {
    setError(''); setDone(''); setBusy(true);
    try { await fn(); } catch (err) { setError(err.message || 'Something went wrong.'); } finally { setBusy(false); }
  };

  const start = () => onRequireStepUp({
    reason: 'Adding a recovery email changes where we can warn you, so we need to confirm it is you.',
    action: async (stepUp) => run(async () => {
      await requestRecoveryEmail(email, stepUp);
      setPending(true);
    }),
  });

  const confirm = () => run(async () => {
    await verifyRecoveryEmail(code);
    setPending(false); setCode(''); setEmail(''); setDone('Recovery email verified.');
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

      {current && !pending && (
        <div className="psc-panel">
          <span className="psc-panel__label">Recovery address</span>
          <span className="psc-panel__value">{current}</span>
          <div className="psc-btn-row">
            <button type="button" className="psc-btn psc-btn--ghost" onClick={() => { setMode('add'); setEmail(''); }} disabled={busy}>
              Change
            </button>
            <button type="button" className="psc-btn psc-btn--danger-ghost" onClick={remove} disabled={busy}>
              Remove
            </button>
          </div>
        </div>
      )}

      {(mode === 'add' || pending) && !current && !pending && (
        <div className="psc-fieldset">
          <label className="psc-label" htmlFor="psc-rec-email">Recovery email address</label>
          <input
            id="psc-rec-email"
            className="psc-input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError(''); }}
            placeholder="name@example.com"
          />
          <button type="button" className="psc-btn psc-btn--primary" onClick={start} disabled={busy || !email}>
            {busy ? 'Sending…' : 'Send confirmation code'}
          </button>
        </div>
      )}

      {mode === 'add' && current && !pending && (
        <div className="psc-fieldset">
          <label className="psc-label" htmlFor="psc-rec-email2">New recovery email address</label>
          <input
            id="psc-rec-email2"
            className="psc-input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError(''); }}
            placeholder="name@example.com"
          />
          <button type="button" className="psc-btn psc-btn--primary" onClick={start} disabled={busy || !email}>
            {busy ? 'Sending…' : 'Send confirmation code'}
          </button>
        </div>
      )}

      {pending && (
        <div className="psc-fieldset">
          <p className="psc-rules">We sent a 6-digit code to <strong>{email}</strong>. It stays unverified until you enter it.</p>
          <label className="psc-label" htmlFor="psc-rec-code">Confirmation code</label>
          <input
            id="psc-rec-code"
            className="psc-input psc-input--otp"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(''); }}
            placeholder="000000"
          />
          <div className="psc-btn-row">
            <button type="button" className="psc-btn psc-btn--primary" onClick={confirm} disabled={busy || code.length !== 6}>
              {busy ? 'Verifying…' : 'Verify and save'}
            </button>
            <button type="button" className="psc-btn psc-btn--ghost" onClick={() => { setPending(false); setCode(''); }} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
