import React, { useState, useEffect } from 'react';
import axios from 'axios';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import './AssessmentManagement.css';
import AssessmentResultsDisplay from '../Components/AssessmentResultsDisplay/AssessmentResultsDisplay';
import ModifyAssessmentModal from '../Components/ModifyAssessmentModal/ModifyAssessmentModal';
import ReadOnlyAssessment from '../Components/ReadOnlyAssessment/ReadOnlyAssessment';

const AssessmentManagement = () => {
  const [users, setUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [assessments, setAssessments] = useState([]);
  const [selectedAssessment, setSelectedAssessment] = useState(null);
  const [modifiedAssessment, setModifiedAssessment] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingAssessments, setIsLoadingAssessments] = useState(false);
  const [assessmentResults, setAssessmentResults] = useState(null);

  const [expandedUser, setExpandedUser] = useState(null);

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const res = await axios.get('/api/admin/users', {
          headers: {
            Authorization: `Bearer ${localStorage.getItem('adminToken')}`,
          },
        });
        setUsers(res.data.users);
      } catch (error) {
        console.error('Error fetching users:', error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchUsers();
  }, []);

  const handleUserToggle = async (userId) => {
    if (expandedUser === userId) {
      setExpandedUser(null);
      setAssessments([]);
    } else {
      setExpandedUser(userId);
      setIsLoadingAssessments(true);
      try {
        const res = await axios.get(`/api/assessment/user/${userId}`, {
          headers: {
            Authorization: `Bearer ${localStorage.getItem('adminToken')}`,
          },
        });
        setAssessments(res.data);
      } catch (error) {
        console.error('Error fetching assessments:', error);
      } finally {
        setIsLoadingAssessments(false);
      }
    }
  };

  const handleViewResults = async (assessmentId) => {
    try {
      const res = await axios.get(`/api/assessment/results/${assessmentId}`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('adminToken')}`,
        },
      });
      setAssessmentResults(res.data);
    } catch (error) {
      console.error('Error fetching assessment results:', error);
    }
  };

  const generatePDF = async (assessment) => {
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const user = users.find(u => u._id === assessment.user);
    let headerDrawnForPage = {};

    // --- Fetch AI Results ---
    let assessmentResults;
    try {
      const res = await axios.get(`/api/assessment/results/${assessment._id}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('adminToken')}` },
      });
      assessmentResults = res.data;
      if (!assessmentResults) throw new Error("Empty results returned");
    } catch (error) {
      console.error('Error fetching assessment results for PDF:', error);
      doc.text("Failed to load AI analysis for this report.", 14, 14);
      doc.save('report-error.pdf');
      return;
    }

    // --- Reusable Header Function ---
    const addReportHeader = (pageNumber) => {
      if (headerDrawnForPage[pageNumber]) return;
      doc.setPage(pageNumber);
      // Green background
      doc.setFillColor(40, 167, 69);
      doc.rect(0, 0, pageWidth, 55, 'F');

      // Main Title
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(32);
      doc.setTextColor(255, 255, 255);
      doc.text('SuppliWise', 14, 22);

      // Subtitle
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(12);
      doc.text('Personalized Supplement & Wellness Report', 14, 30);

      // User and Date
      doc.setFontSize(11);
      const userName = user ? `${user.firstName} ${user.lastName}` : 'N/A';
      doc.text('Prepared for:', 14, 45);
      doc.setFont('helvetica', 'bold');
      doc.text(userName, 45, 45);

      const reportDate = new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
      doc.setFont('helvetica', 'normal');
      doc.text(reportDate, pageWidth - 14, 45, { align: 'right' });
      headerDrawnForPage[pageNumber] = true;
    };

    // --- Reusable Footer ---
    const addReportFooter = (pageNumber, pageCount) => {
      doc.setPage(pageNumber);
      doc.setFontSize(10);
      doc.setTextColor(150);
      doc.text(`Page ${pageNumber} of ${pageCount}`, pageWidth / 2, pageHeight - 10, { align: 'center' });
    };

    // --- Build PDF Content ---
    addReportHeader(1);
    let startY = 70;

    // Disclaimer Box
    doc.setFillColor(232, 245, 233);
    doc.roundedRect(14, startY, pageWidth - 28, 22, 3, 3, 'F');
    doc.setFillColor(40, 167, 69);
    doc.rect(14, startY, 2, 22, 'F');
    doc.setFontSize(9);
    doc.setTextColor(50);
    const disclaimerText = 'For educational and wellness purposes only. This report does not diagnose, treat, or cure any disease. Always consult a licensed healthcare professional before starting any supplement regimen.';
    const disclaimerLines = doc.splitTextToSize(disclaimerText, pageWidth - 40);
    doc.text(disclaimerLines, 20, startY + 7);
    startY += 32;

    // Clinical Summary
    doc.setFillColor(40, 167, 69);
    doc.rect(14, startY, 2, 7, 'F');
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(40, 167, 69);
    doc.text('CLINICAL SUMMARY', 20, startY + 5.5);
    startY += 15;

    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(0);
    const summaryLines = doc.splitTextToSize(assessmentResults.summary, pageWidth - 28);
    doc.text(summaryLines, 14, startY);
    startY += doc.getTextDimensions(summaryLines).h + 15;

    // Recommendations Section
    if (assessmentResults.recommendations && assessmentResults.recommendations.length > 0) {
      doc.setFillColor(40, 167, 69);
      doc.rect(14, startY, 2, 7, 'F');
      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(40, 167, 69);
      doc.text('RECOMMENDATION PLAN', 20, startY + 5.5);
      startY += 15;

      assessmentResults.recommendations.forEach(rec => {
        const recBody = [
          ['Reason', rec.reason],
          ['Dosage', rec.dosage],
          ['Timing', rec.timing],
          ['Priority', rec.priority],
          ['Interactions', rec.interactions],
          ['Foods', rec.foods],
          ['Side Effects', rec.sideEffects],
          ['Evidence', rec.evidence],
          ['Confidence', `${rec.confidenceScore}%`],
        ].map(([key, value]) => [key, doc.splitTextToSize(String(value || 'N/A'), pageWidth - 100)]);
        
        autoTable(doc, {
          startY: startY,
          head: [[{ content: rec.name, colSpan: 2, styles: { halign: 'center', fillColor: [40, 167, 69], textColor: 255, fontStyle: 'bold' } }]],
          body: recBody,
          theme: 'grid',
          styles: { cellPadding: 2, fontSize: 9 },
          headStyles: { halign: 'center' },
          columnStyles: { 0: { fontStyle: 'bold', cellWidth: 30 } },
          didDrawPage: (data) => {
            addReportHeader(data.pageNumber);
          }
        });
        startY = doc.lastAutoTable.finalY + 10;
      });
    }

    // --- Finalize PDF with Footers ---
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      addReportFooter(i, pageCount);
    }

    doc.save(`SuppliWise_Report_${user ? `${user.firstName}_${user.lastName}` : ''}_${new Date().toLocaleDateString('en-CA')}.pdf`);
  };

  const handleViewAssessment = (assessment) => {
    setSelectedAssessment(assessment);
  };

  const refreshAssessments = async (userId) => {
    if (!userId) return;
    setIsLoadingAssessments(true);
    try {
      const res = await axios.get(`/api/assessment/user/${userId}`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('adminToken')}`,
        },
      });
      setAssessments(res.data);
    } catch (error) {
      console.error('Error fetching assessments:', error);
    } finally {
      setIsLoadingAssessments(false);
    }
  };

  const deleteAssessment = async (assessmentId) => {
    if (window.confirm('Are you sure you want to delete this assessment? This action cannot be undone.')) {
      try {
        await axios.delete(`/api/assessment/${assessmentId}`, {
          headers: {
            Authorization: `Bearer ${localStorage.getItem('adminToken')}`,
          },
        });
        setModifiedAssessment(null);
        await refreshAssessments(expandedUser);
      } catch (error) {
        console.error('Error deleting assessment:', error);
      }
    }
  };

  const saveModifiedAssessment = async (assessment) => {
    try {
      await axios.patch(`/api/assessment/${assessment._id}`, assessment, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('adminToken')}`,
        },
      });
      setModifiedAssessment(null);
      // Refresh assessments for the user
      await refreshAssessments(expandedUser);
    } catch (error) {
      console.error('Error saving assessment:', error);
    }
  };

  return (
    <div className="am-container">
      <div className="am-user-list">
        {isLoading ? (
          <p className="am-empty">Loading users…</p>
        ) : users && users.length > 0 ? (
          users.map((user) => {
            const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Unknown';
            const initials = fullName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
            const isOpen = expandedUser === user._id;

            // Deterministic avatar colour from name
            const palette = ['#0891b2','#4f6bed','#2e9e6b','#d46b35','#7c4ddb','#e85d75','#b45309','#be185d'];
            let hash = 0;
            for (let i = 0; i < fullName.length; i++) hash = fullName.charCodeAt(i) + ((hash << 5) - hash);
            const avatarBg = palette[Math.abs(hash) % palette.length];

            return (
              <div key={user._id} className={`am-user-item${isOpen ? ' am-user-item--open' : ''}`}>
                {/* ── User row ──────────────────────────────────────── */}
                <button
                  className="am-user-row"
                  onClick={() => handleUserToggle(user._id)}
                  aria-expanded={isOpen}
                >
                  {/* Avatar */}
                  {user.profilePicture ? (
                    <img
                      className="am-avatar"
                      src={user.profilePicture}
                      alt={fullName}
                      onError={e => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling.style.display = 'flex'; }}
                    />
                  ) : null}
                  <span
                    className="am-avatar am-avatar--initials"
                    style={{ background: avatarBg, display: user.profilePicture ? 'none' : 'flex' }}
                    aria-hidden="true"
                  >
                    {initials}
                  </span>

                  {/* Name + joined */}
                  <span className="am-user-info">
                    <span className="am-user-name">{fullName}</span>
                    <span className="am-user-sub">Joined: {new Date(user.createdAt).toLocaleDateString()}</span>
                  </span>

                  {/* Assessment count pill */}
                  <span className="am-count-pill">
                    {user.assessmentCount ?? 0} {(user.assessmentCount ?? 0) === 1 ? 'assessment' : 'assessments'}
                  </span>

                  {/* Chevron */}
                  <span className={`am-chevron${isOpen ? ' am-chevron--open' : ''}`} aria-hidden="true">▼</span>
                </button>

                {/* ── Assessment cards ───────────────────────────── */}
                {isOpen && (
                  <div className="am-assessment-list">
                    {isLoadingAssessments ? (
                      <p className="am-empty">Loading assessments…</p>
                    ) : assessments.length === 0 ? (
                      <p className="am-empty">No assessments found for this user.</p>
                    ) : (
                      assessments.map((assessment) => {
                        // Real expiry — createdAt + 5 years, or assessment.expiresAt
                        const expiryDate = assessment.expiresAt
                          ? new Date(assessment.expiresAt)
                          : (() => { const d = new Date(assessment.createdAt); d.setFullYear(d.getFullYear() + 5); return d; })();

                        return (
                          <div key={assessment._id} className="am-card">
                            {/* Card header */}
                            <div className="am-card__header">
                              <span className="am-pill am-pill--active">ACTIVE</span>
                              <span className="am-card__date">
                                {new Date(assessment.createdAt).toLocaleString()}
                              </span>
                            </div>

                            {/* Symptoms summary */}
                            <p className="am-card__symptoms">
                              {Array.isArray(assessment.symptoms) && assessment.symptoms.length > 0
                                ? assessment.symptoms.join(', ')
                                : 'No symptoms recorded'}
                            </p>

                            {/* Tag pills */}
                            <div className="am-tags">
                              {assessment.age && (
                                <span className="am-tag">Age {assessment.age}</span>
                              )}
                              {assessment.dietType && (
                                <span className="am-tag">{assessment.dietType}</span>
                              )}
                              {assessment.activityLevel && (
                                <span className="am-tag">{assessment.activityLevel}</span>
                              )}
                              {Array.isArray(assessment.symptoms) && assessment.symptoms.length > 0 && (
                                <span className="am-tag am-tag--green">
                                  {assessment.symptoms.length} symptom{assessment.symptoms.length !== 1 ? 's' : ''}
                                </span>
                              )}
                              {assessment.aiResults && (
                                <span className="am-tag am-tag--blue">✓ AI Analysis</span>
                              )}
                            </div>

                            {/* Footer */}
                            <div className="am-card__footer">
                              <span className="am-card__expiry">
                                Expires {expiryDate.toLocaleString()}
                              </span>
                              <div className="am-actions">
                                <button className="am-btn am-btn--grey"   onClick={() => handleViewAssessment(assessment)}>View</button>
                                <button className="am-btn am-btn--blue"   onClick={() => handleViewResults(assessment._id)}>Results</button>
                                <button className="am-btn am-btn--blue"   onClick={() => generatePDF(assessment)}>PDF</button>
                                <button className="am-btn am-btn--blue"   onClick={() => setModifiedAssessment(assessment)}>Modify</button>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })
        ) : (
          <p className="am-empty">No users found.</p>
        )}
      </div>

      {/* ── Modals ─────────────────────────────────────────────────── */}
      {selectedAssessment && (
        <div className="am-modal" onClick={e => e.target === e.currentTarget && setSelectedAssessment(null)}>
          <div className="am-modal__content">
            <ReadOnlyAssessment
              assessment={selectedAssessment}
              onClose={() => setSelectedAssessment(null)}
            />
          </div>
        </div>
      )}
      {assessmentResults && (
        <div className="am-modal" onClick={e => e.target === e.currentTarget && setAssessmentResults(null)}>
          <div className="am-modal__content">
            <button className="am-modal__close" onClick={() => setAssessmentResults(null)} aria-label="Close">&times;</button>
            <AssessmentResultsDisplay results={assessmentResults} />
          </div>
        </div>
      )}
      {modifiedAssessment && (
        <ModifyAssessmentModal
          assessment={modifiedAssessment}
          onClose={() => setModifiedAssessment(null)}
          onSave={saveModifiedAssessment}
          onDelete={deleteAssessment}
        />
      )}
    </div>
  );
};

export default AssessmentManagement;