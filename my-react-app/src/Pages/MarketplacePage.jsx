import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import {
  getListings,
  createListing,
  placeOrder,
  getOrders,
  confirmDelivery,
  openDispute,
  getDisputes,
  voteDispute,
} from '../api/web3';
import {
  Spinner,
  Alert,
  CopyChip,
  Empty,
  TabBar,
  fmtWell,
  fmtDay,
  usePanelState,
} from '../Components/Web3Panels/w3ui';
import './Web3.css';

// P2P marketplace with smart-contract escrow (features 3, 4 & 15): buyers
// lock WELL in escrow, sellers get paid only on delivery confirmation, and
// disputes go to a stake-weighted juror vote.
const CATEGORIES = ['Vitamins', 'Minerals', 'Herbs', 'Protein', 'Probiotics', 'Other'];

const STATUS_BADGE = { escrow: 'amber', released: 'green', refunded: 'red' };

const TABS = [
  { key: 'browse', icon: '🛒', label: 'Browse' },
  { key: 'orders', icon: '📦', label: 'My Orders' },
  { key: 'sell', icon: '🏷️', label: 'Sell' },
  { key: 'disputes', icon: '⚖️', label: 'Disputes' },
];

export default function MarketplacePage() {
  const { loading, setLoading, alert, ok, fail, clear, info } = usePanelState();
  const [tab, setTab] = useState('browse');
  const [market, setMarket] = useState(null); // { listings, feePct, oracleFeeds }
  const [mine, setMine] = useState([]);
  const [orders, setOrders] = useState({ bought: [], sold: [] });
  const [disputeData, setDisputeData] = useState({ disputes: [], jurorReward: 0 });
  const [qtys, setQtys] = useState({});
  const [discount, setDiscount] = useState('');
  const [disputeTarget, setDisputeTarget] = useState(null); // order being disputed
  const [disputeReason, setDisputeReason] = useState('');
  const [busy, setBusy] = useState(false);

  // New listing form
  const [form, setForm] = useState({
    title: '',
    description: '',
    brand: '',
    category: CATEGORIES[0],
    priceWell: '',
    stock: '10',
  });

  const load = async () => {
    try {
      setLoading(true);
      const [m, mineRes, o, d] = await Promise.all([
        getListings(),
        getListings(true),
        getOrders(),
        getDisputes(),
      ]);
      setMarket(m);
      setMine(mineRes.listings || []);
      setOrders({ bought: o.bought || [], sold: o.sold || [] });
      setDisputeData({ disputes: d.disputes || [], jurorReward: d.jurorReward || 0 });
      clear();
    } catch (err) {
      fail(err, 'Could not load the marketplace.');
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

  const buy = (listingId) => {
    const qty = Math.max(1, parseInt(qtys[listingId], 10) || 1);
    return run(
      () => placeOrder({ listingId, qty, discountCode: discount.trim() }),
      (r) => {
        setDiscount('');
        setTab('orders');
        ok(`Order placed — ${fmtWell(r.order.total)} WELL locked in escrow (tx ${String(r.escrowTx).slice(0, 12)}…).`);
      }
    );
  };

  const confirmDeliveryNow = (orderId) =>
    run(
      () => confirmDelivery(orderId),
      (r) => {
        setTab('orders');
        ok(`Delivery confirmed — ${fmtWell(r.proceeds)} WELL released to the seller, ${fmtWell(r.fee)} WELL protocol fee.`);
      }
    );

  const submitDispute = () =>
    run(
      () => openDispute(disputeTarget, disputeReason),
      () => {
        setDisputeTarget(null);
        setDisputeReason('');
        setTab('disputes');
        ok('Dispute opened — jurors selected, escrow stays locked until a verdict.');
      }
    );

  const vote = (disputeId, choice) =>
    run(
      () => voteDispute(disputeId, choice),
      (r) => (r.resolved
        ? ok(`Vote recorded — dispute resolved in favour of the ${r.outcome}.`)
        : info('Vote recorded — waiting for the remaining jurors.'))
    );

  const submitListing = () =>
    run(
      () => createListing({
        title: form.title.trim(),
        description: form.description.trim(),
        brand: form.brand.trim(),
        category: form.category,
        priceWell: Number(form.priceWell),
        stock: Number(form.stock),
      }),
      (r) => {
        setForm({ ...form, title: '', description: '', brand: '', priceWell: '', stock: '10' });
        setTab('browse');
        ok(`Listing "${r.listing.title}" published and anchored on-chain.`);
      }
    );

  if (loading && !market) return <Spinner />;

  const emptyOrders = orders.bought.length === 0 && orders.sold.length === 0;

  const orderRow = (o, side) => (
    <tr key={`${side}-${o._id}`}>
      <td style={{ fontWeight: 600 }}>{o.listingTitle}</td>
      <td>{o.qty}</td>
      <td>
        {fmtWell(o.total)} WELL
        {o.discount > 0 && (
          <div style={{ fontSize: 12, color: '#16a34a' }}>
            −{fmtWell(o.discount)} ({o.discountCode})
          </div>
        )}
      </td>
      <td>
        <span className={`w3-badge ${STATUS_BADGE[o.status] || ''}`}>{o.status}</span>
        {o.settleTx ? <div style={{ marginTop: 4 }}><CopyChip value={o.settleTx} label="settle" /></div> : null}
      </td>
      <td>{fmtDay(o.createdAt)}</td>
      <td>
        {side === 'buy' && o.status === 'escrow' ? (
          <span className="w3-row" style={{ gap: 6 }}>
            <button className="w3-btn small" disabled={busy} onClick={() => confirmDeliveryNow(o._id)}>
              Confirm
            </button>
            <button
              className="w3-btn danger small"
              disabled={busy}
              onClick={() => { setDisputeTarget(o._id); setDisputeReason(''); clear(); }}
            >
              Dispute
            </button>
          </span>
        ) : side === 'buy' && o.status === 'released' ? (
          <span className="w3-badge green">Completed ✓</span>
        ) : (
          <span className="w3-mono">—</span>
        )}
      </td>
    </tr>
  );

  return (
    <div className="w3-page">
      <Navbar />
      <div className="w3-container">
        <header className="w3-header">
          <h1 className="w3-title">🛒 Verified Marketplace</h1>
          <p className="w3-subtitle">
            Peer-to-peer supplement trading with on-chain escrow — funds release only when you
            confirm delivery, and any disagreement goes to a decentralized jury.
          </p>
        </header>

        <div className="w3-subnav">
          <Link className="w3-btn ghost small" to="/web3">← Web3 Hub</Link>
          <Link className="w3-btn ghost small" to="/governance">🏛️ Governance</Link>
          <Link className="w3-btn ghost small" to="/verify">🔍 Verify a product</Link>
        </div>

        <TabBar
          tabs={TABS}
          active={tab}
          onChange={(key) => { setTab(key); setDisputeTarget(null); clear(); }}
          label="Marketplace sections"
        />

        <Alert alert={alert} onClear={clear} />

        <div
          className="w3-tabpanel"
          id="w3-tabpanel"
          role="tabpanel"
          aria-labelledby={`w3tab-${tab}`}
          tabIndex={-1}
        >

        {/* ── Browse ─────────────────────────────────────────────────── */}
        {tab === 'browse' && market && (
          <div>
            <div className="w3-card accent">
              {/* Fee chip sits with the heading it describes — it used to be
                  pushed to the far edge of a full-width row, reading as an
                  unrelated floating label. */}
              <div className="w3-card-title">
                🔓 Escrow-protected trading
                <span className="w3-badge green">protocol fee {market.feePct}%</span>
              </div>
              <p className="w3-card-sub">
                Payment is locked in the escrow contract until delivery is confirmed. On release
                the {market.feePct}% protocol fee goes to the DAO treasury and the remainder is paid
                to the seller.
              </p>
              {Array.isArray(market.oracleFeeds) && market.oracleFeeds.length > 0 && (
                <div className="w3-row" style={{ gap: 8 }}>
                  {market.oracleFeeds.map((f) => (
                    <span className="w3-badge blue" key={f.key}>
                      {f.label}: {f.value}{f.unit ? ` ${f.unit}` : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="w3-row" style={{ alignItems: 'flex-end', marginBottom: 16 }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <label className="w3-label" htmlFor="mkt-discount">Loyalty code (optional)</label>
                <input
                  id="mkt-discount"
                  className="w3-input"
                  placeholder="LOY-XXXXXXXX"
                  value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                />
              </div>
            </div>

            {market.listings.length === 0 ? (
              <Empty icon="🛒">No listings yet — be the first to publish one in the Sell tab.</Empty>
            ) : (
              <div className="w3-grid two">
                {market.listings.map((l) => (
                  <div className="w3-listing" key={l._id}>
                    <div className="w3-row between">
                      <span className="w3-listing-brand">{l.brand || l.category}</span>
                      <span className="w3-badge">{l.stock} in stock</span>
                    </div>
                    <div className="w3-listing-title">{l.title}</div>
                    <div className="w3-listing-desc">{l.description || 'No description provided.'}</div>
                    <div className="w3-row between" style={{ marginTop: 6 }}>
                      <span className="w3-price">{fmtWell(l.priceWell)} <small>WELL</small></span>
                      <span className="w3-row" style={{ gap: 8 }}>
                        <input
                          className="w3-input"
                          style={{ width: 70 }}
                          type="number"
                          min="1"
                          max={l.stock}
                          value={qtys[l._id] || 1}
                          onChange={(e) => setQtys((q) => ({ ...q, [l._id]: e.target.value }))}
                          aria-label={`Quantity for ${l.title}`}
                        />
                        <button
                          className="w3-btn small"
                          disabled={busy || l.stock < 1}
                          onClick={() => buy(l._id)}
                        >
                          Buy
                        </button>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── My orders ──────────────────────────────────────────────── */}
        {tab === 'orders' && (
          <div>
            {disputeTarget && (
              <div className="w3-card accent">
                <div className="w3-card-title">⚖️ Open a dispute</div>
                <p className="w3-card-sub">
                  Describe the problem — jurors (staked WELL holders) will review the evidence and
                  their vote decides whether you get refunded or the seller gets paid.
                </p>
                <textarea
                  className="w3-textarea"
                  placeholder="What went wrong with this order? (min 10 characters)"
                  value={disputeReason}
                  onChange={(e) => setDisputeReason(e.target.value)}
                  aria-label="Dispute reason"
                />
                <div className="w3-row" style={{ marginTop: 12 }}>
                  <button
                    className="w3-btn danger"
                    disabled={busy || disputeReason.trim().length < 10}
                    onClick={submitDispute}
                  >
                    File dispute
                  </button>
                  <button className="w3-btn ghost" onClick={() => setDisputeTarget(null)} disabled={busy}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {emptyOrders ? (
              <Empty icon="📦">No orders yet — buy something from the Browse tab.</Empty>
            ) : (
              <>
                <div className="w3-card">
                  <div className="w3-card-title">🛍️ Bought</div>
                  {orders.bought.length === 0 ? (
                    <Empty icon="🛒">You haven’t bought anything yet.</Empty>
                  ) : (
                    <div className="w3-table-wrap">
                      <table className="w3-table">
                        <thead>
                          <tr><th>Item</th><th>Qty</th><th>Total</th><th>Status</th><th>Ordered</th><th /></tr>
                        </thead>
                        <tbody>{orders.bought.map((o) => orderRow(o, 'buy'))}</tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div className="w3-card">
                  <div className="w3-card-title">🏪 Sold</div>
                  {orders.sold.length === 0 ? (
                    <Empty icon="🏷️">Nothing sold yet — create a listing in the Sell tab.</Empty>
                  ) : (
                    <div className="w3-table-wrap">
                      <table className="w3-table">
                        <thead>
                          <tr><th>Item</th><th>Qty</th><th>Total</th><th>Status</th><th>Ordered</th><th /></tr>
                        </thead>
                        <tbody>{orders.sold.map((o) => orderRow(o, 'sell'))}</tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Sell ───────────────────────────────────────────────────── */}
        {tab === 'sell' && (
          <div>
            <div className="w3-card accent">
              <div className="w3-card-title">🏷️ Create a listing</div>
              <p className="w3-card-sub">
                Listings are anchored on-chain, so your reputation as a seller is public and
                tamper-proof. You receive WELL (minus the {market?.feePct ?? '—'}% protocol fee)
                when the buyer confirms delivery.
              </p>
              <div className="w3-grid">
                <input
                  className="w3-input"
                  placeholder="Title (min 4 chars)"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  aria-label="Title"
                />
                <input
                  className="w3-input"
                  placeholder="Brand"
                  value={form.brand}
                  onChange={(e) => setForm({ ...form, brand: e.target.value })}
                  aria-label="Brand"
                />
                <select
                  className="w3-select"
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  aria-label="Category"
                >
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <input
                  className="w3-input"
                  type="number"
                  min="1"
                  placeholder="Price (WELL)"
                  value={form.priceWell}
                  onChange={(e) => setForm({ ...form, priceWell: e.target.value })}
                  aria-label="Price"
                />
                <input
                  className="w3-input"
                  type="number"
                  min="1"
                  placeholder="Stock"
                  value={form.stock}
                  onChange={(e) => setForm({ ...form, stock: e.target.value })}
                  aria-label="Stock"
                />
              </div>
              <textarea
                className="w3-textarea"
                style={{ marginTop: 14 }}
                placeholder="Description — condition, expiry, why you’re selling…"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                aria-label="Description"
              />
              <button
                className="w3-btn"
                style={{ marginTop: 14 }}
                disabled={busy || form.title.trim().length < 4 || !(Number(form.priceWell) > 0) || !(Number(form.stock) >= 1)}
                onClick={submitListing}
              >
                Publish listing
              </button>
            </div>

            <div className="w3-card">
              <div className="w3-card-title">📦 My listings</div>
              {mine.length === 0 ? (
                <Empty icon="🏷️">You have no active listings.</Empty>
              ) : (
                <div className="w3-table-wrap">
                  <table className="w3-table">
                    <thead>
                      <tr><th>Title</th><th>Category</th><th>Price</th><th>Stock</th><th>Created</th></tr>
                    </thead>
                    <tbody>
                      {mine.map((l) => (
                        <tr key={l._id}>
                          <td style={{ fontWeight: 600 }}>{l.title}</td>
                          <td><span className="w3-badge">{l.category}</span></td>
                          <td>{fmtWell(l.priceWell)} WELL</td>
                          <td>{l.stock}</td>
                          <td>{fmtDay(l.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Disputes ───────────────────────────────────────────────── */}
        {tab === 'disputes' && (
          <div>
            <div className="w3-card">
              <div className="w3-row between">
                <div>
                  <div className="w3-card-title">⚖️ Decentralized dispute resolution</div>
                  <p className="w3-card-sub" style={{ marginBottom: 0 }}>
                    Jurors are chosen from staked WELL holders. Each resolved dispute pays jurors{' '}
                    {fmtWell(disputeData.jurorReward)} WELL for their service.
                  </p>
                </div>
              </div>
            </div>

            {disputeData.disputes.length === 0 ? (
              <Empty icon="⚖️">No disputes — trade confidently, but if something goes wrong it lands here.</Empty>
            ) : (
              disputeData.disputes.map((d) => (
                <div className="w3-card" key={d._id}>
                  <div className="w3-row between">
                    <div className="w3-card-title" style={{ marginBottom: 0 }}>
                      {d.order.listingTitle}{' '}
                      <span className={`w3-badge ${d.status === 'resolved' ? 'green' : 'amber'}`}>
                        {d.status === 'resolved' ? `resolved → ${d.outcome}` : 'open'}
                      </span>
                    </div>
                    <span className="w3-mono">{fmtWell(d.order.total)} WELL in escrow</span>
                  </div>
                  <p className="w3-card-sub" style={{ marginTop: 8 }}>{d.reason}</p>

                  <div className="w3-row" style={{ gap: 8 }}>
                    <span className="w3-badge blue">votes {d.progress.cast}/{d.progress.needed}</span>
                    <span className="w3-badge">{d.votes.length} jurors participating</span>
                    {d.votes.map((v) => (
                      <span
                        className={`w3-badge ${v.choice === 'buyer' ? 'green' : 'purple'}`}
                        key={v.juror + v.at}
                      >
                        {v.choice} · w {fmtWell(v.weight)}
                      </span>
                    ))}
                  </div>

                  {d.canVote && (
                    <div className="w3-row" style={{ marginTop: 14 }}>
                      <button className="w3-btn" disabled={busy} onClick={() => vote(d._id, 'buyer')}>
                        Vote for buyer
                      </button>
                      <button className="w3-btn ghost" disabled={busy} onClick={() => vote(d._id, 'seller')}>
                        Vote for seller
                      </button>
                    </div>
                  )}
                  {d.hasVoted && d.status === 'open' && (
                    <p className="w3-card-sub" style={{ marginTop: 12, marginBottom: 0 }}>
                      ✓ You’ve voted — waiting for the remaining jurors.
                    </p>
                  )}
                </div>
              ))
            )}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
