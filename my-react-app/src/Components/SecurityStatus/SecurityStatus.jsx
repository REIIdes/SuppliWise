import React from 'react';
import './SecurityStatus.css';

const SecurityStatus = ({ securityData }) => {
  if (!securityData) {
    return <div>Loading security status...</div>;
  }

  const { checks, overallStatus, lastScanned, recommendations } = securityData;

  const getStatusClassName = (status) => {
    switch (status.toLowerCase()) {
      case 'secure':
        return 'status-secure';
      case 'vulnerable':
        return 'status-vulnerable';
      case 'critical':
        return 'status-critical';
      default:
        return '';
    }
  };

  return (
    <div className="security-status-container">
      <h2>System Security Status</h2>

      <div className="status-overview">
        <div className={`status-card ${overallStatus.toLowerCase()}`}>
          <h3>Overall Status</h3>
          <p>{overallStatus}</p>
        </div>
        <div className="status-card">
          <h3>Last Scanned</h3>
          <p>{new Date(lastScanned).toLocaleString()}</p>
        </div>
      </div>

      <div className="recommendations">
        <h3>Recommendations</h3>
        {recommendations.length > 0 ? (
          <ul>
            {recommendations.map((rec, index) => (
              <li key={index} className={`recommendation ${rec.priority.toLowerCase()}`}>
                <h4>{rec.title}</h4>
                <p>{rec.description}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p>No security recommendations at this time.</p>
        )}
      </div>

      <div className="additional-precautions">
        <h3>Additional Security Precautions</h3>
        <ul>
          <li>Regularly update all software and dependencies to their latest versions.</li>
          <li>Implement a strong password policy for all user accounts.</li>
          <li>Conduct regular security audits and penetration testing.</li>
          <li>Monitor system logs for suspicious activity.</li>
          <li>Educate users about phishing and other social engineering attacks.</li>
        </ul>
      </div>

      <div className="security-checks-table">
        <h3>Security Checks</h3>
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Security Implement</th>
              <th>Description/Implementation</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((check, index) => (
              <tr key={index}>
                <td>
                  <span className={`status-label ${getStatusClassName(check.status)}`}>
                    {check.status}
                  </span>
                </td>
                <td>{check.framework}</td>
                <td>
                  <strong>{check.label}</strong>
                  <br />
                  <span>{check.implementation}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default SecurityStatus;