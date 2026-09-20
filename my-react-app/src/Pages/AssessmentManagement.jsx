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
    <div>
      <div className="user-list">
        {isLoading ? (
          <p>Loading users...</p>
        ) : users && users.length > 0 ? (
          users.map((user) => (
            <div key={user._id} className="user-item">
              <div className={`user-header ${expandedUser === user._id ? 'expanded' : ''}`} onClick={() => handleUserToggle(user._id)}>
                <img src={user.profilePicture || 'https://i.pravatar.cc/48?u=' + user._id} alt="Profile" className="profile-picture" />
                <div className="user-info">
                  <span>{user.firstName} {user.lastName}</span>
                  <small>Joined: {new Date(user.createdAt).toLocaleDateString()}</small>
                </div>
                <div className="assessment-count">
                  <span>{user.assessmentCount} assessments</span>
                </div>
                <span>▼</span>
              </div>
              {expandedUser === user._id && (
                <div className="assessment-list">
                  {isLoadingAssessments ? (
                    <p>Loading assessments...</p>
                  ) : (
                    assessments.map((assessment) => (
                      <div key={assessment._id} className="assessment-item">
                        <div className="assessment-header">
                          <span className="active-status">ACTIVE</span>
                          <span>{new Date(assessment.createdAt).toLocaleString()}</span>
                        </div>
                        <div className="assessment-body">
                          <p>{assessment.symptoms.join(', ')}</p>
                          <div className="tags">
                            <span>Age {assessment.age}</span>
                            <span>{assessment.dietType}</span>
                            <span>{assessment.activityLevel}</span>
                            <span className="symptom-count">{assessment.symptoms.length} symptoms</span>
                            <span className="ai-analysis">✓ AI Analysis</span>
                          </div>
                        </div>
                        <div className="assessment-footer">
                          <span>Expires Sep 20, 2031, 12:39 PM</span>
                          <div className="actions">
                            <button onClick={() => handleViewAssessment(assessment)}>View</button>
                            <button onClick={() => handleViewResults(assessment._id)}>Results</button>
                            <button onClick={() => generatePDF(assessment)}>PDF</button>
                            <button onClick={() => setModifiedAssessment(assessment)}>Modify</button>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))
        ) : (
          <p>No users found.</p>
        )}
      </div>
      {selectedAssessment && (
        <div className="modal">
          <ReadOnlyAssessment 
            assessment={selectedAssessment} 
            onClose={() => setSelectedAssessment(null)} 
          />
        </div>
      )}
      {assessmentResults && (
        <div className="modal">
          <div className="modal-content">
            <span className="close" onClick={() => setAssessmentResults(null)}>&times;</span>
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