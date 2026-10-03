import { useEffect, useState } from 'react';
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
  Hero,
  AreaNav,
  TabBar,
  fmtWell,
  fmtDay,
  usePanelState,
} from '../Components/Web3Panels/w3ui';
// Clamp a text input to a whole number inside [min, max], so the stepper and
// the Buy button can never disagree about what will be ordered. The behaviour
// is pinned by marketplaceQuantity.test.js.
import { clampQty } from './marketplaceQuantity.js';
import './Web3.css';

// P2P marketplace with smart-contract escrow (features 3, 4 & 15): buyers
// lock WELL in escrow, sellers get paid only on delivery confirmation, and
// disputes go to a stake-weighted juror vote.
const CATEGORIES = ['Vitamins', 'Minerals', 'Herbs', 'Protein', 'Probiotics', 'Other'];

const STATUS_BADGE = { escrow: 'amber', released: 'green', refunded: 'red' };

const STATUS_LABEL = {
  escrow: 'In escrow',
  released: 'Released',
  refunded: 'Refunded',
};

const TABS = [
  { key: 'browse', icon: '🛒', label: 'Browse' },
  { key: 'orders', icon: '📦', label: 'My Orders' },
  { key: 'sell', icon: '🏷️', label: 'Sell' },
  { key: 'disputes', icon: '⚖️', label: 'Disputes' },
];

/** − qty + with a typed value, clamped to what the seller actually has. */
function QtyStepper({ value, max, disabled, onChange, label }) {
  return (
    <div className="w3-stepper">
      <button
        type="button"
        onClick={() => onChange(clampQty(String(value - 1), 1, max))}
        disabled={disabled || value <= 1}
        aria-label={`Decrease quantity for ${label}`}
      >
        −
      </button>
      <input
        type="number"
        inputMode="numeric"
        min="1"
        max={max}
        value={value}
        disabled={disabled}
        aria-label={`Quantity for ${label}`}
        onChange={(e) => onChange(clampQty(e.target.value, 1, max))}
      />
      <button
        type="button"
        onClick={() => onChange(clampQty(String(value + 1), 1, max))}
        disabled={disabled || value >= max}
        aria-label={`Increase quantity for ${label}`}
      >
        +
      </button>
    </div>
  );
}

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

  const buy = (listing) => {
    const qty = clampQty(qtys[listing._id], 1, Math.max(1, listing.stock));
    return run(
      () => placeOrder({ listingId: listing._id, qty, discountCode: discount.trim() }),
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

  // Navbar kept during the first load: a bare spinner replaced the whole page,
  // so the bar blinked out and back in on every cold start of the route.
  if (loading && !market) {
    return (
      <div className="w3-page">
        <Navbar />
        <div className="w3-container">
          <Spinner />
        </div>
      </div>
    );
  }

  const emptyOrders = orders.bought.length === 0 && orders.sold.length === 0;
  const listingReady =
    form.title.trim().length >= 4 &&
    Number(form.priceWell) > 0 &&
    Number(form.stock) >= 1;
  const disputeReady = disputeReason.trim().length >= 10;
  const openEscrows = orders.bought.filter((o) => o.status === 'escrow').length;

  const orderRow = (o, side) => (
    <tr key={`${side}-${o._id}`}>
      <td style={{ fontWeight: 700 }}>{o.listingTitle}</td>
      <td className="num">{o.qty}</td>
      <td className="num">
        {fmtWell(o.total)} WELL
        {o.discount > 0 && (
          <div style={{ fontSize: 12, color: '#047857', fontWeight: 700 }}>
            −{fmtWell(o.discount)} ({o.discountCode})
          </div>
        )}
      </td>
      <td>
        <span className={`w3-badge ${STATUS_BADGE[o.status] || ''}`}>
          {STATUS_LABEL[o.status] || o.status}
        </span>
        {o.settleTx ? <div style={{ marginTop: 5 }}><CopyChip value={o.settleTx} label="settle tx" /></div> : null}
      </td>
      <td>{fmtDay(o.createdAt)}</td>
      <td>
        {side === 'buy' && o.status === 'escrow' ? (
          <span className="w3-row" style={{ gap: 6 }}>
            <button className="w3-btn small" disabled={busy} onClick={() => confirmDeliveryNow(o._id)}>
              Confirm delivery
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
        <Hero
          variant="teal"
          mark="🛒"
          eyebrow="Escrow-protected trading"
          title="Verified Marketplace"
          subtitle="Peer-to-peer supplement trading with on-chain escrow — funds release only when you confirm delivery, and any disagreement goes to a decentralized jury."
        />

        <AreaNav />

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
              <div className="w3-card-head">
                <div>
                  <div className="w3-card-title">🔓 Escrow-protected trading</div>
                  <p className="w3-card-sub">
                    Payment is locked in the escrow contract until delivery is confirmed. On
                    release the {market.feePct}% protocol fee goes to the DAO treasury and the
                    remainder is paid to the seller.
                  </p>
                </div>
                <span className="w3-badge green">protocol fee {market.feePct}%</span>
              </div>
              {/* Oracle read-outs as a labelled mini grid. They were one row of
                  blue pills — "Batch verification pass rate: 99.1 %" — which read
                  as debug output rather than as market context. */}
              {Array.isArray(market.oracleFeeds) && market.oracleFeeds.length > 0 && (
                <div className="w3-grid compact">
                  {market.oracleFeeds.map((f) => (
                    <div className="w3-mini" key={f.key}>
                      <div className="w3-mini-label">{f.label}</div>
                      <div className="w3-mini-value">
                        {f.value}
                        {f.unit ? <span>{f.unit}</span> : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* The loyalty field used to sit on the page on its own, outside
                any surface, so it looked like it belonged to nothing above or
                below it. As a ticket-shaped block it reads as a coupon field
                that applies to the order you are about to place. */}
            <div className="w3-card w3-coupon">
              <div className="w3-coupon-icon" aria-hidden="true">🎟️</div>
              <div className="w3-coupon-body">
                <div className="w3-label" htmlFor="mkt-discount">Loyalty code (optional)</div>
                <p className="w3-card-sub" style={{ marginBottom: 10 }}>
                  Converted WELL into a one-time code? Paste it here — the discount is taken off
                  the order total when you buy.
                </p>
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
              <Empty
                icon="🛒"
                title="No listings yet"
                action={
                  <button className="w3-btn" onClick={() => setTab('sell')}>
                    🏷️ Publish the first listing
                  </button>
                }
              >
                Nobody has listed a supplement yet. Be the first and earn WELL on delivery.
              </Empty>
            ) : (
              <div className="w3-grid two">
                {market.listings.map((l) => {
                  const stock = Math.max(0, Number(l.stock) || 0);
                  const qty = clampQty(qtys[l._id], 1, Math.max(1, stock));
                  const soldOut = stock < 1;
                  return (
                    <article className="w3-listing" key={l._id}>
                      <div className="w3-row between">
                        <span className="w3-listing-brand">{l.brand || l.category}</span>
                        <span className={`w3-badge ${soldOut ? 'red' : stock <= 3 ? 'amber' : ''}`}>
                          {soldOut ? 'Sold out' : `${stock} in stock`}
                        </span>
                      </div>
                      <div className="w3-listing-title">{l.title}</div>
                      <div className="w3-listing-desc">{l.description || 'No description provided.'}</div>
                      <div className="w3-listing-foot">
                        <div className="w3-price">
                          {fmtWell(l.priceWell)} <small>WELL</small>
                        </div>
                        <div className="w3-row" style={{ gap: 8 }}>
                          <QtyStepper
                            value={qty}
                            max={Math.max(1, stock)}
                            disabled={busy || soldOut}
                            onChange={(next) => setQtys((q) => ({ ...q, [l._id]: next }))}
                            label={l.title}
                          />
                          <button
                            className="w3-btn small"
                            disabled={busy || soldOut}
                            onClick={() => buy(l)}
                          >
                            {soldOut ? 'Unavailable' : 'Buy'}
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── My orders ──────────────────────────────────────────────── */}
        {tab === 'orders' && (
          <div>
            {disputeTarget && (
              <div className="w3-card accent">
                <div className="w3-card-head">
                  <div>
                    <div className="w3-card-title">⚖️ Open a dispute</div>
                    <p className="w3-card-sub">
                      Describe the problem — jurors (staked WELL holders) will review the evidence
                      and their vote decides whether you get refunded or the seller gets paid. Your
                      WELL stays locked in escrow until the verdict.
                    </p>
                  </div>
                </div>
                <div className="w3-field">
                  <label className="w3-label" htmlFor="dispute-reason">What went wrong?</label>
                  <textarea
                    id="dispute-reason"
                    className="w3-textarea"
                    placeholder="Describe the problem with this order… (min 10 characters)"
                    value={disputeReason}
                    onChange={(e) => setDisputeReason(e.target.value)}
                  />
                </div>
                <div className="w3-row">
                  <button
                    className="w3-btn danger"
                    disabled={busy || !disputeReady}
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
              <Empty
                icon="📦"
                title="No orders yet"
                action={
                  <button className="w3-btn" onClick={() => setTab('browse')}>
                    🛒 Browse listings
                  </button>
                }
              >
                Anything you buy is locked in escrow until you confirm it arrived.
              </Empty>
            ) : (
              <>
                <div className="w3-card accent">
                  <div className="w3-card-head">
                    <div>
                      <div className="w3-card-title">📊 Your escrow activity</div>
                      <p className="w3-card-sub">
                        {openEscrows > 0
                          ? `${openEscrows} order${openEscrows === 1 ? '' : 's'} waiting on you. Your WELL is released to the seller only when you confirm delivery.`
                          : 'Nothing is locked right now. Funds are released on your confirmation, never before.'}
                      </p>
                    </div>
                    <span className={`w3-badge ${openEscrows > 0 ? 'amber' : 'green'}`}>
                      {openEscrows > 0 ? `⏳ ${openEscrows} awaiting you` : '✓ all settled'}
                    </span>
                  </div>
                </div>

                <div className="w3-card">
                  <div className="w3-card-title">🛍️ Bought</div>
                  {orders.bought.length === 0 ? (
                    <Empty icon="🛒">You haven’t bought anything yet.</Empty>
                  ) : (
                    <div className="w3-table-wrap">
                      <table className="w3-table">
                        <thead>
                          <tr>
                            <th>Item</th><th className="num">Qty</th><th className="num">Total</th>
                            <th>Status</th><th>Ordered</th><th />
                          </tr>
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
                          <tr>
                            <th>Item</th><th className="num">Qty</th><th className="num">Total</th>
                            <th>Status</th><th>Ordered</th><th />
                          </tr>
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
              <div className="w3-card-head">
                <div>
                  <div className="w3-card-title">🏷️ Create a listing</div>
                  <p className="w3-card-sub">
                    Listings are anchored on-chain, so your reputation as a seller is public and
                    tamper-proof. You receive WELL (minus the {market?.feePct ?? '—'}% protocol fee)
                    when the buyer confirms delivery.
                  </p>
                </div>
                <span className="w3-badge green">fee {market?.feePct ?? '—'}%</span>
              </div>
              <div className="w3-grid">
                <div>
                  <label className="w3-label" htmlFor="sell-title">Title</label>
                  <input
                    id="sell-title"
                    className="w3-input"
                    placeholder="e.g. Magnesium Glycinate 90ct"
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                  />
                </div>
                <div>
                  <label className="w3-label" htmlFor="sell-brand">Brand</label>
                  <input
                    id="sell-brand"
                    className="w3-input"
                    placeholder="Optional"
                    value={form.brand}
                    onChange={(e) => setForm({ ...form, brand: e.target.value })}
                  />
                </div>
                <div>
                  <label className="w3-label" htmlFor="sell-category">Category</label>
                  <select
                    id="sell-category"
                    className="w3-select"
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                  >
                    {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="w3-label" htmlFor="sell-price">Price (WELL)</label>
                  <input
                    id="sell-price"
                    className="w3-input"
                    type="number"
                    min="1"
                    step="0.01"
                    placeholder="13.13"
                    value={form.priceWell}
                    onChange={(e) => setForm({ ...form, priceWell: e.target.value })}
                  />
                </div>
                <div>
                  <label className="w3-label" htmlFor="sell-stock">Stock</label>
                  <input
                    id="sell-stock"
                    className="w3-input"
                    type="number"
                    min="1"
                    placeholder="10"
                    value={form.stock}
                    onChange={(e) => setForm({ ...form, stock: e.target.value })}
                  />
                </div>
              </div>
              <div className="w3-field" style={{ marginTop: 14, marginBottom: 0 }}>
                <label className="w3-label" htmlFor="sell-desc">Description</label>
                <textarea
                  id="sell-desc"
                  className="w3-textarea"
                  placeholder="Condition, expiry, why you’re selling…"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>
              <button
                className="w3-btn"
                style={{ marginTop: 14 }}
                disabled={busy || !listingReady}
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
                      <tr>
                        <th>Title</th><th>Category</th><th className="num">Price</th>
                        <th className="num">Stock</th><th>Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mine.map((l) => (
                        <tr key={l._id}>
                          <td style={{ fontWeight: 700 }}>{l.title}</td>
                          <td><span className="w3-badge">{l.category}</span></td>
                          <td className="num">{fmtWell(l.priceWell)} WELL</td>
                          <td className="num">{l.stock}</td>
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
            <div className="w3-card accent">
              <div className="w3-card-head">
                <div>
                  <div className="w3-card-title">⚖️ Decentralized dispute resolution</div>
                  <p className="w3-card-sub">
                    Jurors are chosen from staked WELL holders. Each resolved dispute pays jurors{' '}
                    {fmtWell(disputeData.jurorReward)} WELL for their service.
                  </p>
                </div>
              </div>
            </div>

            {disputeData.disputes.length === 0 ? (
              <Empty icon="⚖️" title="No open disputes">
                Trade confidently — but if something goes wrong, the escrow stays locked and the
                case lands here.
              </Empty>
            ) : (
              disputeData.disputes.map((d) => {
                const needed = Math.max(1, d.progress?.needed || 1);
                const cast = d.progress?.cast || 0;
                const juryPct = Math.min(100, Math.round((cast / needed) * 100));
                return (
                  <article className="w3-card" key={d._id}>
                    <div className="w3-card-head">
                      <div>
                        <h3 className="w3-card-title">
                          {d.order.listingTitle}
                          <span className={`w3-badge ${d.status === 'resolved' ? 'green' : 'amber'}`}>
                            {d.status === 'resolved' ? `resolved → ${d.outcome}` : 'open'}
                          </span>
                        </h3>
                        <p className="w3-card-sub">{d.reason}</p>
                      </div>
                      <span className="w3-badge red">{fmtWell(d.order.total)} WELL in escrow</span>
                    </div>

                    <div
                      className="w3-progress"
                      role="progressbar"
                      aria-label="Jury votes cast"
                      aria-valuemin={0}
                      aria-valuemax={needed}
                      aria-valuenow={Math.min(cast, needed)}
                    >
                      <div className="w3-progress-bar" style={{ width: `${juryPct}%` }} />
                    </div>
                    <div className="w3-vote-legend">
                      <span>Jury progress</span>
                      <span className={`quorum ${juryPct >= 100 ? 'met' : ''}`}>
                        {cast}/{needed} votes cast
                      </span>
                    </div>

                    <div className="w3-row" style={{ gap: 8, marginTop: 12 }}>
                      {d.votes.map((v) => (
                        <span
                          className={`w3-badge ${v.choice === 'buyer' ? 'green' : 'purple'}`}
                          key={v.juror + v.at}
                        >
                          {v.choice === 'buyer' ? '👤 buyer' : '🏪 seller'} · w {fmtWell(v.weight)}
                        </span>
                      ))}
                    </div>

                    {d.canVote && (
                      <div className="w3-row" style={{ marginTop: 14 }}>
                        <button className="w3-btn" disabled={busy} onClick={() => vote(d._id, 'buyer')}>
                          Vote for buyer
                        </button>
                        <button className="w3-btn accent" disabled={busy} onClick={() => vote(d._id, 'seller')}>
                          Vote for seller
                        </button>
                      </div>
                    )}
                    {d.hasVoted && d.status === 'open' && (
                      <p className="w3-card-sub" style={{ marginTop: 12, marginBottom: 0 }}>
                        ✓ You’ve voted — waiting for the remaining jurors.
                      </p>
                    )}
                  </article>
                );
              })
            )}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
