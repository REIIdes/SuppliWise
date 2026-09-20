import React from 'react';
import './ModifyAssessmentModal.css';

const ModifyAssessmentModal = ({ assessment, onClose, onSave, onDelete }) => {
  const handleSetPriority = (priority) => {
    onSave({ ...assessment, priority: priority });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Modify Assessment</h2>
          <button className="close-button" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <p>Select an action for this assessment.</p>
          <div className="action-buttons">
            <button 
              className={`priority-button ${assessment.priority === 'Priority' ? 'active' : ''}`} 
              onClick={() => handleSetPriority('Priority')}
            >
              Set as Priority
            </button>
            <button 
              className={`priority-button ${assessment.priority !== 'Priority' ? 'active' : ''}`} 
              onClick={() => handleSetPriority('Standard')}
            >
              Set as Standard
            </button>
            <button className="delete-button" onClick={() => onDelete(assessment._id)}>
              Delete Assessment
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ModifyAssessmentModal;