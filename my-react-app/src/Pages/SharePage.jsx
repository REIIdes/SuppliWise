import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import { getSharedProfile } from '../api/web3';
import { Spinner, Stat, CopyChip, fmtTime, fmtDay } from '../Components/Web3Panels/w3ui';
import './Web3.css';

// PUBLIC: the doctor / nutritionist view of a time-boxed, revocable health
// profile share link (feature 16). No account needed; the token itself is the
// capability, gated server-side by expiry + revocation.
export default function SharePage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setError('');
        setData(await getSharedProfile(token));
      } catch (err) {
        setError(err.message || 'This share link is no longer valid.');
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  const profile = data?.sharedProfile;

  return (
    <div className="w3-page">
      <Navbar />
      <div className="w3-container" style={{ maxWidth: 860 }}>
        <header className="w3-header">
          <h1 className="w3-title">🩺 Shared Health Profile</h1>
          <p className="w3-subtitle">
            Shared by the account holder via SuppliWise — read-only, time-boxed and revocable.
          </p>
        </header>

        {loading && <Spinner />}

        {!loading && error && (
          <div className="w3-card">
            <div className="w3-verify-hero" style={{ padding: '10px 0' }}>
              <span className="w3-verify-badge bad">⚠️ LINK UNAVAILABLE</span>
              <p className="w3-subtitle">{error}</p>
              <p className="w3-card-sub" style={{ marginTop: 8 }}>
                Share links expire, and the owner can revoke them at any time from the Web3 Hub →
                Privacy tab.
              </p>
            </div>
          </div>
        )}

        {!loading && profile && (
          <>
            <div className="w3-card accent">
              <div className="w3-card-title">👤 {profile.name}</div>
              <p className="w3-card-sub">
                {profile.gender || '—'}{profile.age != null ? ` · ${profile.age} years` : ''} ·
                valid until {fmtTime(data.expiresAt)} · viewed {data.views} time(s)
              </p>
              <div className="w3-grid">
                <Stat value={profile.assessmentCount} label="Assessments" tone="green" />
                <Stat value={profile.intakeCount} label="Intake entries" />
                <Stat value={`${profile.trackingStreak}d`} label="Tracking streak" tone="amber" />
                <Stat value={`${profile.overallAdherencePct}%`} label="Adherence" />
              </div>
              <p className="w3-card-sub" style={{ marginTop: 14, marginBottom: 0 }}>⚠️ {data.disclaimer}</p>
            </div>

            <div className="w3-card">
              <div className="w3-card-title">🧾 Latest assessment context</div>
              {profile.latestAssessment ? (
                <div className="w3-table-wrap">
                  <table className="w3-table">
                    <tbody>
                      <tr>
                        <td style={{ fontWeight: 600, width: 190 }}>Completed</td>
                        <td>{fmtTime(profile.latestAssessment.at)}</td>
                      </tr>
                      <tr>
                        <td style={{ fontWeight: 600 }}>Health goals</td>
                        <td>{(profile.latestAssessment.healthGoals || []).join(', ') || '—'}</td>
                      </tr>
                      <tr>
                        <td style={{ fontWeight: 600 }}>Symptoms</td>
                        <td>{(profile.latestAssessment.symptoms || []).join(', ') || '—'}</td>
                      </tr>
                      <tr>
                        <td style={{ fontWeight: 600 }}>Medical conditions</td>
                        <td>{profile.latestAssessment.medicalConditions || '—'}</td>
                      </tr>
                      <tr>
                        <td style={{ fontWeight: 600 }}>Current medications</td>
                        <td>{profile.latestAssessment.currentMedications || '—'}</td>
                      </tr>
                      <tr>
                        <td style={{ fontWeight: 600 }}>Allergies</td>
                        <td>{profile.latestAssessment.allergies || '—'}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="w3-card-sub" style={{ marginBottom: 0 }}>No assessment on record.</p>
              )}
            </div>

            {profile.lastLedgerAnchor && (
              <div className="w3-card">
                <div className="w3-card-title">⚓ Integrity anchor</div>
                <p className="w3-card-sub">
                  The holder’s record history was digested and anchored on-chain on{' '}
                  {fmtDay(profile.lastLedgerAnchor.at)} — proof it existed unchanged at that time.
                </p>
                <div className="w3-row" style={{ gap: 10 }}>
                  <span className="w3-badge blue">block #{profile.lastLedgerAnchor.blockIndex}</span>
                  <CopyChip value={profile.lastLedgerAnchor.digest} label={profile.lastLedgerAnchor.digest} />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
