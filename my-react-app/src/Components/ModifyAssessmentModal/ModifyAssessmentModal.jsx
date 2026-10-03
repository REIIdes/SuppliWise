import { useEffect, useState } from 'react';
import { BASE_URL, parseJSON } from '../../api';
import ConfirmModal from '../ConfirmModal/ConfirmModal';
import './ModifyAssessmentModal.css';

// Request timeout so slow networks can't hang the modal actions forever
const REQUEST_TIMEOUT_MS = 30000;

async function adminFetch(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/assessment${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('adminToken')}`,
        ...options.headers,
      },
      signal: controller.signal,
    });
    const data = await parseJSON(res);
    if (!res.ok) {
      const err = new Error(data?.message || 'Request failed');
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Request timed out. Please check your connection and try again.', { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const ModifyAssessmentModal = ({ assessment, onClose, onSave, onDelete }) => {
  // Track the current priority optimistically so the active state updates immediately
  const [currentPriority, setCurrentPriority] = useState(
    assessment.priority || 'Standard'
  );
  const [loading, setLoading] = useState(null); // 'priority' | 'delete' | null
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Stay in sync if the assessment prop changes underneath (auto-lift/reflag,
  // list refresh) so the buttons always reflect the live flagged review state
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional prop sync for live priority state
    setCurrentPriority(assessment.priority || 'Standard');
    setError('');
    setSuccess('');
  }, [assessment._id, assessment.priority]);

  // ── Set Priority / Standard ──────────────────────────────────────────
  const handleSetPriority = async (priority) => {
    if (loading) return;
    setLoading('priority');
    setError('');
    setSuccess('');
    try {
      const data = await adminFetch(`/${assessment._id}/priority`, {
        method: 'PATCH',
        body: JSON.stringify({ priority }),
      });
      setCurrentPriority(priority);
      setSuccess(data.message || `Assessment set to ${priority}.`);
      // Notify parent so the card in the list reflects the new priority
      if (onSave) onSave({ ...assessment, priority });
    } catch (err) {
      setError(err.message || 'Failed to update priority. Please try again.');
      // Expired admin session: send back to login instead of a dead error
      if (err.status === 401) {
        setTimeout(() => {
          localStorage.removeItem('adminToken');
          localStorage.removeItem('admin');
          window.location.href = '/admin/login';
        }, 1500);
      }
    } finally {
      setLoading(null);
    }
  };

  // ── Delete ────────────────────────────────────────────────────────────
  // No window.confirm(): the Android webview swallows it (the Delete button
  // looked dead) and a native dialog cannot be styled. The in-app warning
  // modal is the same one the admin "Delete account" flow uses.
  const requestDelete = () => {
    if (loading) return;
    setConfirmDelete(true);
  };

  const handleDelete = async () => {
    if (loading) return;
    setConfirmDelete(false);
    setLoading('delete');
    setError('');
    setSuccess('');
    try {
      await adminFetch(`/${assessment._id}`, { method: 'DELETE' });
      if (onDelete) onDelete(assessment._id);
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to delete assessment. Please try again.');
      if (err.status === 401) {
        setTimeout(() => {
          localStorage.removeItem('adminToken');
          localStorage.removeItem('admin');
          window.location.href = '/admin/login';
        }, 1500);
      } else {
        setLoading(null);
      }
    }
  };

  return (
    <div className="mam-overlay" onClick={onClose}>
      <div className="mam-content" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="mam-header">
          <h2 className="mam-title">Modify Assessment</h2>
          <button className="mam-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        {/* Body */}
        <div className="mam-body">
          <p className="mam-sub">Select an action for this assessment.</p>

          {/* Feedback */}
          {error   && <div className="mam-alert mam-alert--error"   role="alert">{error}</div>}
          {success && <div className="mam-alert mam-alert--success" role="status">{success}</div>}

          <div className="mam-actions">

            {/* Set as Priority */}
            <button
              className={`mam-btn mam-btn--outline${currentPriority === 'Priority' ? ' mam-btn--active-priority' : ''}`}
              onClick={() => handleSetPriority('Priority')}
              disabled={loading !== null}
              aria-pressed={currentPriority === 'Priority'}
            >
              {loading === 'priority' && currentPriority !== 'Priority'
                ? 'Saving…'
                : currentPriority === 'Priority'
                  ? '★ Priority (current)'
                  : 'Set as Priority'}
            </button>

            {/* Set as Standard */}
            <button
              className={`mam-btn mam-btn--green${currentPriority === 'Standard' ? ' mam-btn--active-standard' : ''}`}
              onClick={() => handleSetPriority('Standard')}
              disabled={loading !== null}
              aria-pressed={currentPriority === 'Standard'}
            >
              {loading === 'priority' && currentPriority !== 'Standard'
                ? 'Saving…'
                : currentPriority === 'Standard'
                  ? '✓ Standard (current)'
                  : 'Set as Standard'}
            </button>

            {/* Delete */}
            <button
              type="button"
              className="mam-btn mam-btn--delete"
              onClick={requestDelete}
              disabled={loading !== null}
            >
              {loading === 'delete' ? 'Deleting…' : 'Delete Assessment'}
            </button>

          </div>
        </div>
      </div>

      {/* Delete warning — rendered after the overlay so its z-index (2000)
          always wins over the assessment sheet (1100). */}
      {confirmDelete && (
        <ConfirmModal
          type="danger"
          title="Delete this assessment?"
          message="This permanently removes the assessment and everything attached to it. This cannot be undone."
          confirmText="Yes, delete it"
          cancelText="Keep assessment"
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
};

export default ModifyAssessmentModal;
