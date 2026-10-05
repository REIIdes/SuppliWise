import { useEffect, useState } from 'react';
import {
  getTrials, optInTrial, withdrawTrial,
  getOracleFeeds, refreshOracle,
  getExperts, bookExpert, getBookings, cancelBooking,
} from '../../api/web3';
import { Spinner, Alert, CopyChip, Empty, fmtDay, fmtWell, trunc, usePanelState } from './w3ui';

// Features 18 (clinical trials + smart-contract consent), 19 (decentralized
// oracles for real-world data) and 20 (tokenized access to professionals).
export default function EcosystemPanel() {
  const { loading, setLoading, alert, ok, fail, clear } = usePanelState();
  const [trials, setTrials] = useState([]);
  const [feeds, setFeeds] = useState([]);
  const [experts, setExperts] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [hours, setHours] = useState({});
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      const [t, f, e, b] = await Promise.all([
        getTrials(), getOracleFeeds(), getExperts(), getBookings(),
      ]);
      setTrials(t.trials || []);
      setFeeds(f.feeds || []);
      setExperts(e.experts || []);
      setBookings(b.bookings || []);
      clear();
    } catch (err) {
      fail(err, 'Could not load the ecosystem.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect -- intentional initial load on mount */ }, []);

  const run = async (fn, onSuccess) => {
    try {
      setBusy(true);
      clear();
      const res = await fn();
      if (onSuccess) onSuccess(res);
      await load();
      return res;
    } catch (err) {
      fail(err);
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (loading && trials.length === 0 && feeds.length === 0) return <Spinner />;

  const totalBooked = bookings.filter((b) => b.status === 'confirmed').reduce((s, b) => s + (b.cost || 0), 0);

  return (
    <div>
      <Alert alert={alert} onClear={clear} />

      {/* ── Oracle feeds (19) ────────────────────────────────────────── */}
      <div className="w3-card accent">
        <div className="w3-row between">
          <div>
            <div className="w3-card-title">📡 Decentralized oracle feeds</div>
            <p className="w3-card-sub">
              Trusted real-world data — market prices, study counts, verification rates — signed and
              anchored daily so smart contracts (and you) never act on stale numbers.
            </p>
          </div>
          <button
            className="w3-btn ghost small"
            disabled={busy}
            onClick={() => run(() => refreshOracle(), (r) => ok(`Oracle refreshed for ${r.day}.`))}
          >
            🔄 Refresh feeds
          </button>
        </div>
        <div className="w3-table-wrap">
          <table className="w3-table">
            <thead>
              <tr><th>Feed</th><th>Value</th><th>Category</th><th>Updated</th><th>Proof</th></tr>
            </thead>
            <tbody>
              {feeds.map((f) => (
                <tr key={f.key}>
                  <td style={{ fontWeight: 600 }}>{f.label}</td>
                  <td className="w3-mono" style={{ fontSize: 15, color: '#16a34a', fontWeight: 700 }}>
                    {f.value}{f.unit ? ` ${f.unit}` : ''}
                  </td>
                  <td><span className="w3-badge blue">{f.category}</span></td>
                  <td>{fmtDay(f.updatedAt)}</td>
                  <td>{f.txHash ? <CopyChip value={f.txHash} /> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {feeds.length === 0 && <Empty icon="📡">No feeds yet — hit “Refresh feeds”.</Empty>}
      </div>

      {/* ── Clinical trials (18) ─────────────────────────────────────── */}
      <div className="w3-card">
        <div className="w3-card-title">🧬 Secure clinical trial participation</div>
        <p className="w3-card-sub">
          Opt in with a smart-contract consent: exact terms hashed on-chain, scope explicit,
          withdrawal a single click — and you're rewarded in WELL.
        </p>
        <div className="w3-grid two">
          {trials.map((t) => (
            <div className="w3-listing" key={t._id}>
              <div className="w3-row between">
                <span className="w3-badge purple">{t.phase}</span>
                <span className="w3-listing-brand">{t.sponsor}</span>
              </div>
              <div className="w3-listing-title">{t.title}</div>
              <div className="w3-listing-desc">{t.description}</div>
              <div className="w3-row between" style={{ marginTop: 6 }}>
                <span className="w3-price">+{t.rewardWell} <small>WELL</small></span>
                {t.consent?.status === 'opted-in' ? (
                  <span className="w3-row" style={{ gap: 8 }}>
                    <span className="w3-badge green">Consented ✓</span>
                    <button
                      className="w3-btn danger small"
                      disabled={busy}
                      onClick={() => run(() => withdrawTrial(t._id), () => ok('Consent withdrawn and recorded on-chain.'))}
                    >
                      Withdraw
                    </button>
                  </span>
                ) : (
                  <button
                    className="w3-btn small"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () => optInTrial(t._id),
                        (r) => ok(`Opted in! Terms hashed on-chain — +${r.reward} WELL.`)
                      )
                    }
                  >
                    Opt in
                  </button>
                )}
              </div>
              {t.consent && (
                <div className="w3-row" style={{ gap: 8 }}>
                  <CopyChip value={t.consent.termsHash} label={`terms ${trunc(t.consent.termsHash, 8, 6)}`} />
                  {t.consent.consentTx ? <CopyChip value={t.consent.consentTx} label="consent tx" /> : null}
                </div>
              )}
            </div>
          ))}
        </div>
        {trials.length === 0 && <Empty icon="🧬">No open trials right now.</Empty>}
      </div>

      {/* ── Professionals (20) ───────────────────────────────────────── */}
      <div className="w3-card">
        <div className="w3-card-title">🩺 Tokenized access to health professionals</div>
        <p className="w3-card-sub">
          Spend WELL on consultation time with verified nutritionists and functional-medicine
          practitioners — payment settles on-chain instantly.
        </p>
        <div className="w3-grid two">
          {experts.map((e) => (
            <div className="w3-listing" key={e._id}>
              <div className="w3-row between">
                <span className="w3-badge green">{e.specialty}</span>
                <span className="w3-listing-brand">{e.title}</span>
              </div>
              <div className="w3-listing-title">{e.name}</div>
              <div className="w3-mono" style={{ fontSize: 12, color: '#6b7280' }}>{e.credential}</div>
              <div className="w3-listing-desc">{e.bio}</div>
              <div className="w3-row between" style={{ marginTop: 6 }}>
                <span className="w3-price">{e.rateWell} <small>WELL / hour</small></span>
                <span className="w3-row" style={{ gap: 8 }}>
                  <select
                    className="w3-select"
                    style={{ width: 90 }}
                    value={hours[e._id] || 1}
                    onChange={(ev) => setHours((h) => ({ ...h, [e._id]: Number(ev.target.value) }))}
                    aria-label="Hours"
                  >
                    {[1, 2, 3, 4].map((h) => <option key={h} value={h}>{h}h</option>)}
                  </select>
                  <button
                    className="w3-btn small"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () => bookExpert(e._id, hours[e._id] || 1),
                        (r) => ok(`Booked! ${fmtWell(r.booking?.cost)} WELL paid — tx ${r.txHash.slice(0, 10)}…`)
                      )
                    }
                  >
                    Book
                  </button>
                </span>
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 18 }}>
          <div className="w3-row between">
            <span className="w3-label" style={{ margin: 0 }}>My bookings</span>
            <span className="w3-badge amber">{fmtWell(totalBooked)} WELL committed</span>
          </div>
          {bookings.length === 0 ? (
            <Empty icon="📅">No consultations booked yet.</Empty>
          ) : (
            <div className="w3-table-wrap">
              <table className="w3-table">
                <thead>
                  <tr><th>Professional</th><th>Hours</th><th>Cost</th><th>When</th><th>Status</th><th /></tr>
                </thead>
                <tbody>
                  {bookings.map((b) => (
                    <tr key={b._id}>
                      <td style={{ fontWeight: 600 }}>{b.expert?.name || '—'}</td>
                      <td>{b.hours}h</td>
                      <td>{fmtWell(b.cost)} WELL</td>
                      <td>{fmtDay(b.createdAt)}</td>
                      <td>
                        <span className={`w3-badge ${b.status === 'confirmed' ? 'green' : 'red'}`}>{b.status}</span>
                      </td>
                      <td>
                        {b.status === 'confirmed' && (
                          <button
                            className="w3-btn ghost small"
                            disabled={busy}
                            onClick={() =>
                              run(
                                () => cancelBooking(b._id),
                                () => ok('Booking cancelled and refunded.')
                              )
                            }
                          >
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
