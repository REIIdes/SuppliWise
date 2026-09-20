import React, { useState } from 'react';
import axios from 'axios';
import './ModifyAssessmentModal.css';

const ModifyAssessmentModal = ({ assessment, onClose, onSave, onDelete }) => {
  // Track the current priority optimistically so the active state updates immediately
  const [currentPriority, setCurrentPriority] = useState(
    assessment.priority || 'Standard'
  );
  const [loading, setLoading] = useState(null); // 'priority' | 'delete' | null
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');

  // ── Set Priority / Standard ──────────────────────────────────────────
  const handleSetPriority = async (priority) => {
    if (loading) return;
    setLoading('priority');
    setError('');
    setSuccess('');
    try {
      const res = await axios.patch(
        `/api/assessment/${assessment._id}/priority`,
        { priority },
        { headers: { Authorization: `Bearer ${localStorage.getItem('adminToken')}` } }
      );
      setCurrentPriority(priority);
      setSuccess(res.data.message || `Assessment set to ${priority}.`);
      // Notify parent so the card in the list reflects the new priority
      if (onSave) onSave({ ...assessment, priority });
    } catch (err) {
      setError(
        err.response?.data?.message || 'Failed to update priority. Please try again.'
      );
    } finally {
      setLoading(null);
    }
  };

  // ── Delete ────────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (loading) return;
    if (!window.confirm('Delete this assessment? This cannot be undone.')) return;
    setLoading('delete');
    setError('');
    setSuccess('');
    try {
      await axios.delete(
        `/api/assessment/${assessment._id}`,
        { headers: { Authorization: `Bearer ${localStorage.getItem('adminToken')}` } }
      );
      if (onDelete) onDelete(assessment._id);
      onClose();
    } catch (err) {
      setError(
        err.response?.data?.message || 'Failed to delete assessment. Please try again.'
      );
      setLoading(null);
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
              className="mam-btn mam-btn--delete"
              onClick={handleDelete}
              disabled={loading !== null}
            >
              {loading === 'delete' ? 'Deleting…' : 'Delete Assessment'}
            </button>

          </div>
        </div>
      </div>
    </div>
  );
};

export default ModifyAssessmentModal;
