import { useId, useState } from 'react';
import './ChatKeyRecovery.css';

export default function ChatKeyRecovery({ secure, locked = false, onRestored }) {
  const inputId = useId();
  const [code, setCode] = useState('');
  const [shownCode, setShownCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const createCode = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      setShownCode(await secure.createRecoveryCode());
    } catch (cause) {
      setError(cause?.message || 'Could not create a recovery code.');
    } finally {
      setBusy(false);
    }
  };

  const restoreKey = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await secure.restoreIdentity(code);
      setCode('');
      const readable = await onRestored?.();
      setNotice(readable === false
        ? 'Your account key was restored, but it does not unlock this conversation. A device or account that already has access must share this conversation key with you.'
        : 'Encryption key restored and conversation reopened.');
    } catch (cause) {
      setError(cause?.message || 'Could not restore your encryption key. Check the code and try again.');
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(shownCode);
      setNotice('Recovery code copied. Store it somewhere private and separate from this device.');
    } catch {
      setError('Could not copy the code. Select and copy it manually before dismissing this message.');
    }
  };

  if (secure.status === 'needs-key' || (locked && secure.status === 'ready')) {
    return (
      <section className="chat-key-recovery" aria-labelledby="chat-key-restore-title">
        <h2 id="chat-key-restore-title">Restore encrypted chats</h2>
        {secure.recoveryAvailable?.hasRecovery ? (
          <>
            <p>Enter the recovery code you saved when setting up encryption. It is used on this device only.</p>
            <form className="chat-key-recovery__form" onSubmit={restoreKey}>
              <label htmlFor={inputId}>Recovery code</label>
              <input
                id={inputId}
                autoComplete="off"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="SWK-…"
                required
              />
              <button type="submit" disabled={busy || !code.trim()}>
                {busy ? 'Restoring…' : 'Restore key'}
              </button>
            </form>
          </>
        ) : (
          <p>This account has no saved recovery copy. The key for this conversation may only be restored from another device that still has access.</p>
        )}
        {error && <p className="chat-key-recovery__error" role="alert">{error}</p>}
        {notice && <p className="chat-key-recovery__notice" role="status">{notice}</p>}
      </section>
    );
  }

  if (secure.status !== 'ready' || secure.recoveryAvailable?.hasRecovery || shownCode) {
    return shownCode ? (
      <section className="chat-key-recovery" aria-labelledby="chat-key-code-title">
        <h2 id="chat-key-code-title">Save your recovery code</h2>
        <p>This code is the only way to restore your encryption key on another device. Suppliwise cannot recover it for you.</p>
        <output className="chat-key-recovery__code" aria-label="Your recovery code">{shownCode}</output>
        <div className="chat-key-recovery__actions">
          <button type="button" onClick={copyCode}>Copy code</button>
          <button type="button" onClick={() => { setShownCode(''); setNotice(''); }}>
            I saved it
          </button>
        </div>
        {error && <p className="chat-key-recovery__error" role="alert">{error}</p>}
        {notice && <p className="chat-key-recovery__notice" role="status">{notice}</p>}
      </section>
    ) : null;
  }

  return (
    <section className="chat-key-recovery" aria-labelledby="chat-key-setup-title">
      <div>
        <h2 id="chat-key-setup-title">Protect access to encrypted chats</h2>
        <p>Set up a recovery code to restore this account’s encryption key on another device.</p>
      </div>
      <button type="button" onClick={createCode} disabled={busy}>
        {busy ? 'Creating…' : 'Set up recovery code'}
      </button>
      {error && <p className="chat-key-recovery__error" role="alert">{error}</p>}
    </section>
  );
}
