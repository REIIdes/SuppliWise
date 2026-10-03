import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import {
  getPlanCatalogue,
  purchasePlan,
  quotePlan,
  submitPlanRequest,
  getMyPlanRequests,
  downgradeToFree,
  requestCancellation,
  getMyCancelRequests,
} from '../api';
import useAuth from '../hooks/useAuth';
import useSubscription, { publishSubscription } from '../hooks/useSubscription';
import { PLAN_RANK } from '../subscription/features';
import {
  PLAN_CARD_ORDER,
  PLAN_META,
  TEAM_META,
  buildInfoColumns,
  planDisplayName,
  requestedCurrency,
  writeCurrencyPreference,
  clearCurrencyPreference,
  currencySourceNote,
} from '../subscription/catalogue';
import { buildSheetActions, actionBarClassName, KIND_PRIMARY } from '../subscription/sheetActions';
import {
  buildCancelActions,
  cancelActionBarClassName,
  CANCEL_MODES,
  CANCEL_MODE_COPY,
  CANCEL_MODE_REVIEW,
  CANCEL_MODE_IMMEDIATE,
} from '../subscription/cancelSheetActions';
import { buildProofCopy } from '../subscription/paymentCopy';
import { PLAN_LABELS } from '../subscription/features';
import { daysLeftFrom } from '../utils/plan';
// ── Icons (inline SVG, so they render identically on every platform) ───────
import './PricingPage.css';
const CheckIcon = ({ size = 15 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
);
const ArrowIcon = ({ size = 15 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
const InfoIcon = ({ size = 17 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" /> <path d="M12 8h.01M11 12h1v4h1" />
  </svg>
);
const ShieldIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 3 4 6v6c0 4.5 3.2 8.4 8 9.5 4.8-1.1 8-5 8-9.5V6l-8-3Z" />
    <path d="m9.2 12.2 2 2 3.6-3.8" />
  </svg>
);
const GaugeIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 18a8 8 0 1 1 16 0" /> <path d="m12 14 4-4" />
    <circle cx="12" cy="14" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);
const RefreshIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.5" /> <path d="M4 4v4.5h4.5" />
    <path d="M4 13a8 8 0 0 0 13.7 4.7L20 15.5" /> <path d="M20 20v-4.5h-4.5" />
  </svg>
);
const INFO_ICONS = { shield: ShieldIcon, gauge: GaugeIcon, refresh: RefreshIcon };

// ── Per-tier glyphs ───────────────────────────────────────────────────
//
// One mark per plan, so a card is identifiable at a glance from the row above
// it — and the marks are a ladder (seedling → bolt → crown → gem) that matches
// what each tier actually adds. They are decoration, never the only signal:
// every one of them sits beside the plan's name in text.
//
// Keyed by the STORED plan id, not the display name, because that is what the
// grid iterates. An id with no entry falls back to the neutral info glyph.
const SeedIcon = () => (
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 21v-8" /> <path d="M12 13C12 9 9 6 5 6c0 4 3 7 7 7Z" />
    <path d="M12 13c0-3 2.5-5 6-5 0 3-2.5 5-6 5Z" />
  </svg>
);
const BoltIcon = () => (
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z" />
  </svg>
);
const CrownIcon = () => (
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 8l3.5 3L12 5l5.5 6L21 8l-1.5 9h-15L3 8Z" /> <path d="M4.5 20h15" />
  </svg>
);
const GemIcon = () => (
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6 3h12l4 6-10 12L2 9l4-6Z" /> <path d="M2 9h20" /> <path d="m8 3 4 18 4-18" />
    <path d="m2 9 6 0 4-6" />
  </svg>
);
const PLAN_GLYPHS = { free: SeedIcon, monthly: BoltIcon, annual: CrownIcon, custom: GemIcon };
/** "30 days remaining" / "Permanent" / "Expired 3 days ago". */
function durationText(end, permanent) {
  if (permanent) return 'Permanent — never expires';
  if (!end) return 'No expiry set';
  const days = daysLeftFrom(end);
  if (days === null) return 'No expiry set';
  if (days <= 0) return 'Expired';
  return `${days} day${days === 1 ? '' : 's'} remaining`;
}
function formatDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── Proof-of-payment upload ────────────────────────────────────────────
// The limits are the SAME numbers the server enforces
// (server/utils/subscriptionRequests.js): 2 MB, PNG/JPEG/WebP only. Checking
// them here means an oversized or wrong-type pick fails instantly with a
// readable message instead of after a multi-megabyte upload the server rejects.
//
// SVG is not accepted: an SVG data URL is a script vector, and it is rejected on
// the server too — this list is a convenience, the server is the rule.
const PROOF_MAX_BYTES = 2 * 1024 * 1024;
const PROOF_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const PROOF_ACCEPT = PROOF_TYPES.join(',');
function readProofFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('Please choose your payment receipt.'));
      return;
    }
    if (!PROOF_TYPES.includes(file.type)) {
      reject(new Error('The proof of payment must be a PNG, JPEG or WebP image.'));
      return;
    }
    if (file.size > PROOF_MAX_BYTES) {
      reject(new Error('That image is too large. Please use a smaller screenshot (max 2 MB).'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file. Please try another image.'));
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.startsWith('data:image/')) {
        reject(new Error('Could not read that file. Please try another image.'));
        return;
      }
      resolve({ dataUrl: reader.result, mime: file.type, bytes: file.size });
    };
    reader.readAsDataURL(file);
  });
}
/** "820 KB" — the picker shows the real size so a 4 MB photo is caught before upload. */
function prettyBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
} // NOTE: there is deliberately no money formatter on this page. Prices arrive// already formatted by the server (`pricing.formatted.*`), because the// conversion and the rounding both happen there. Formatting a number here is// exactly how a pricing page ends up showing a price that disagrees with the// invoice.
export default function PricingPage() {
  // Live plan from the shared subscription store, so the "your plan" banner and
  // the current-plan CTAs update the instant an admin changes anything — this
  // page never keeps its own copy of the subscription.
  const navigate = useNavigate();
  // Reactive session: the page is a public route, so it must flip between
  // guest and signed-in copy the moment the token appears or disappears.
  const live = useSubscription();
  const { token } = useAuth();
  const isSignedIn = !!token;
  const [catalogue, setCatalogue] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  // The visitor's own currency choice, or null to let the server detect it.
  const [yearly, setYearly] = useState(false);
  const [currencyChoice, setCurrencyChoice] = useState(() =>
    requestedCurrency(typeof window === 'undefined' ? '' : window.location.search),
  );
  // { planId, months, seats, step: 'summary' | 'proof' }
  // Team seat count for the checkout sheet. Kept outside `checkout` so changing
  // it re-renders the sheet's total without re-opening it, and so the choice
  // survives closing and re-opening the sheet.
  const [checkout, setCheckout] = useState(null);
  const [seats, setSeats] = useState(TEAM_META.minSeats);
  const [busyPlan, setBusyPlan] = useState(null);
  // Proof-of-payment form state. Reset every time the sheet opens, so a failed
  // attempt never leaves the previous receipt in the box.
  const [sheetError, setSheetError] = useState('');
  // { dataUrl, mime, bytes }
  const [proof, setProof] = useState(null);
  // True while a receipt is dragged over the upload box. Purely visual, but it
  // is the only feedback a drag gives before release, so without it a desktop
  // member cannot tell the box accepts drops.
  const [proofError, setProofError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [reference, setReference] = useState('');
  // The member's existing requests, so the form can say "you already asked"
  // BEFORE a 2 MB upload instead of bouncing a 409 back afterwards.
  const [requestNote, setRequestNote] = useState('');
  const [myRequests, setMyRequests] = useState([]);
  // ── Cancelling back to Free ──────────────────────────────────────────────
  // The Free card's button used to navigate to the dashboard and change
  // nothing, which read as a dead button: the member pressed it and stayed on
  // the same paid plan. It now opens this sheet instead, which offers the two
  // honest doors — end it now, or ask an administrator to do it.
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelMode, setCancelMode] = useState(CANCEL_MODE_REVIEW);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelBusy, setCancelBusy] = useState(false);
  // Existing cancellations, so the sheet can say "one is already waiting" before
  // the member presses a button that would only earn a 409.
  const [cancelError, setCancelError] = useState('');
  const [myCancels, setMyCancels] = useState([]);
  const cancelRef = useRef(null);
  const [toast, setToast] = useState(null); // { tone, message }
  const toastTimer = useRef(null);
  // The native file input behind the styled upload button. The picker and a
  // drag-and-drop both funnel through attachProofFile; this element only exists
  // to open the OS picker.
  const confirmRef = useRef(null);
  // Monotonic read ticket for the attached receipt.
  //
  // It has to be a counter, NOT the input's own `files`. The picker path empties
  // the input the moment a file is taken (so picking the same file twice in a
  // row still fires `change`), which means `input.files[0]` is `undefined` by
  // the time FileReader resolves — so an "is this still the newest pick?" check
  // written against it rejects EVERY read. That bug attached nothing, silently,
  // every single time, while the UI sat there looking like it had worked.
  //
  // Bumping the ticket is also how a reset voids a read in flight, so a slow
  // 2 MB read cannot land in a sheet the member has already moved on from.
  // Declared here, with the other refs, because choosePlan and closeCheckout —
  // both defined ABOVE the picker — reset the proof.
  const fileInputRef = useRef(null);
  // ── Load the catalogue (server-owned prices + currency) ──────────────────
  //
  // Deliberately does NO synchronous setState: mounting the page must not
  // trigger the cascading re-render that a sync setState inside an effect
  // causes. `loading` starts true, so the skeleton is already correct, and the
  // only transitions happen after the await.
  //
  // The token guards against out-of-order responses, which a plain boolean
  // "cancelled" flag set on unmount cannot cover when a manual retry overlaps
  // the first request — or when a currency change is still in flight.
  const proofTicket = useRef(0);
  const loadToken = useRef(0);
  const loadCatalogue = useCallback(async ({ retry = false, currency = null } = {}) => {
    const token = ++loadToken.current;
    if (retry) {
      setLoading(true);
      setLoadError('');
    }
    try {
      const data = await getPlanCatalogue(currency);
      if (token !== loadToken.current) return;
      setCatalogue(data);
    } catch (error) {
      // The page stays readable: it explains that pricing is unavailable rather
      // than rendering cards with invented numbers.
      if (token !== loadToken.current) return;
      setLoadError(error?.message || 'We could not load the plan catalogue.');
    } finally {
      if (token === loadToken.current) setLoading(false);
    }
  }, []);
  // Fetching the catalogue is an external-system sync: `loadCatalogue` awaits
  // the network before it touches any state, so running it from an effect cannot
  // cause a cascading render.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- async load populates state from the server
  useEffect(() => { loadCatalogue({ currency: currencyChoice }); }, [loadCatalogue, currencyChoice]);
  /**
   * Switch currency.
   *
   * The choice is persisted and re-requested; the SERVER does the conversion, so
   * this never computes a price. Switching back to "auto" clears the stored
   * preference, which hands the decision back to location detection.
   */
  const changeCurrency = useCallback((code) => {
    const next = String(code || '').trim().toUpperCase() || null;
    setCurrencyChoice(next);
    if (next) writeCurrencyPreference(next);
    else clearCurrencyPreference();
  }, []); // Toast auto-dismiss. Kept in a ref so a re-render never restarts the timer.
  const showToast = useCallback((tone, message) => {
    setToast({ tone, message });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  }, []);
  useEffect(
    () => () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    },
    [],
    // ── Current plan, resolved once for the whole page ──────────────────────
    //
    // `liveActive` was read in two places below without ever being declared — a
    // ReferenceError thrown on EVERY render, so the whole signed-in pricing page
    // landed in the error boundary and the visitor got "Something went wrong"
    // instead of prices. Declared here, next to the other derived facts, and
    // narrowed to a real boolean so `&&` chains behave.
  );
  const liveActive = live.active === true;
  const currentPlanId = liveActive ? live.plan : 'free';
  const currentRank = PLAN_RANK[currentPlanId] ?? 0;
  const pricingFor = useCallback(
    (planId) => {
      const entry = catalogue?.plans?.find((p) => p.id === planId); // The server is authoritative, down to the formatted string. Until the
      // catalogue lands (or if it fails) the card renders a neutral placeholder
      // rather than a made-up number — a skeleton that says "—" is honest, a
      // skeleton that says "$25" is a lie that might get screenshotted.
      if (!entry?.pricing?.formatted) {
        return {
          monthly: null,
          yearly: null,
          monthlyEquivalent: null,
          savedPct: 0,
          formatted: { monthly: '—', yearly: '—', monthlyEquivalent: '—' },
          ready: false,
        };
      }
      return { ...entry.pricing, ready: true };
    },
    [catalogue],
    // ── Choosing a plan ─────────────────────────────────────────────────────
    // `isTeam` opens the same checkout as any other plan, with a seat count — Team
    // is a real purchasable plan (Premium entitlements across N seats), not a
    // "contact us" band.
  );
  const choosePlan = useCallback(
    (planId, { isTeam = false } = {}) => {
      if (planId === 'free') {
        navigate(isSignedIn ? '/dashboard' : '/signup');
        return;
      }
      if (!isSignedIn) {
        // Signing in first is what makes the purchase attributable to an account.
        // The destination travels in router state because that is what the login
        // form resumes from (it runs the value through safeRedirectPath, so only a
        // same-origin path like this one survives) — a query param would be
        // silently dropped and the user would land on the dashboard instead.
        navigate('/login', { state: { redirectTo: '/pricing' } });
        return;
      } // Start a Team checkout at whatever the account already has, so renewing
      // does not silently drop a 10-seat practice back to the minimum.
      const wanted = isTeam
        ? Math.max(
            TEAM_META.minSeats,
            Math.min(TEAM_META.maxSeats, live.seats || TEAM_META.minSeats),
          )
        : 1;
      // Always start on the summary step. Where it goes from there depends on the
      // deployment: with self-serve billing on it can confirm instantly, and the
      // proof-of-payment form is one click away for anyone who paid by transfer.
      // With it off, the proof form IS the route — that is the whole point of the
      // sheet existing.
      if (isTeam) setSeats(wanted);
      // Void any read still in flight, so an image cannot land in the NEXT plan's
      // sheet after the member has moved on. Bumping the ticket is what does that,
      // and a ref is stable, so choosePlan's identity does not change per render.
      setSheetError('');
      proofTicket.current += 1;
      setProof(null);
      setProofError('');
      setDragOver(false);
      setReference('');
      setRequestNote('');
      // `seats` is deliberately NOT stored on `checkout`. `checkout` is frozen for
      // the life of the sheet, so a seat count kept there would be the value from
      // the moment the sheet opened — a second, stale copy that a purchase could
      // read by mistake and charge the wrong amount for. The single source of
      // truth is the `seats` state above, which the stepper writes and the
      // handlers read.
      setMyRequests([]);
      setCheckout({ planId, months: yearly ? 12 : 1, step: 'summary' });
    },
    [isSignedIn, live.seats, navigate, yearly],
  );
  const closeCheckout = useCallback(() => {
    setCheckout(null);
    // Same reasoning as choosePlan: drop the receipt on the way out too, so
    // re-opening for a different plan never shows the previous payment.
    setSheetError('');
    proofTicket.current += 1;
    setProof(null);
    setProofError('');
    setDragOver(false);
  }, []); // ── Cancelling back to Free ──────────────────────────────────────────────
  // Opens the cancel sheet. `choosePlan('free')` used to navigate straight to
  // the dashboard here and change nothing at all, which is why the button read
  // as dead. Fetch the member's existing cancellations on the way in so the
  // sheet can say "one is already waiting" before they press anything.
  const openCancel = useCallback(() => {
    if (!isSignedIn) {
      navigate('/login', { state: { redirectTo: '/pricing' } });
      return;
    }
    setCancelError('');
    setCancelMode(CANCEL_MODE_REVIEW);
    setCancelOpen(true);
    getMyCancelRequests(5)
      .then((data) => setMyCancels(Array.isArray(data.requests) ? data.requests : []))
      .catch(() => setMyCancels([]));
  }, [isSignedIn, navigate]);
  const closeCancel = useCallback(() => {
    setCancelOpen(false);
    setCancelError('');
    setCancelReason('');
  }, []);
  /**   * * * Commit the cancellation through whichever door is selected. * * Both   * doors end in the same place, so the handler is one function: the * server   * decides what `mode` means, and the response carries the fresh * subscription   * state either way. Committing it to the shared store is what * makes every   * open tab drop to Free without a refresh.   */
  const commitCancel = useCallback(async () => {
    // Guard on the in-flight flag, not just the button's disabled state: a
    // double-click racing the re-render must never send two cancellations. The
    // button is disabled while busy, but that is UI politeness — this is the rule.
    if (cancelBusy) return;
    setCancelBusy(true);
    setCancelError('');
    try {
      // Each door calls its own endpoint. The server treats
      // `mode: 'immediate'` on the request route as the same thing, so either
      // path is correct — but calling the dedicated one keeps the intent
      // readable at the call site, and leaves the request route free to stay a
      // pure "ask a human" surface.
      const immediate = cancelMode === CANCEL_MODE_IMMEDIATE;
      const data = immediate
        ? await downgradeToFree(cancelReason)
        : await requestCancellation({ mode: CANCEL_MODE_REVIEW, reason: cancelReason }); // Publish the fresh server snapshot into the shared store FIRST, exactly
      // as a purchase does, so every open tab drops to Free before this page
      // even closes its sheet. No refresh, no re-login.
      if (data?.subscription) publishSubscription(data.subscription);
      showToast('ok', data?.message || 'Your plan has ended — you are back on Free.');
      setMyCancels([]);
      setCancelOpen(false);
      setCancelReason('');
    } catch (error) {
      setCancelError(error?.message || 'We could not cancel your plan. Please try again.');
    } finally {
      setCancelBusy(false);
    }
  }, [cancelBusy, cancelMode, cancelReason, showToast]); // ── Move between the two steps of the sheet ─────────────────────────────
  const goToStep = useCallback((step) => {
    setCheckout((current) => (current ? { ...current, step } : current));
    // A drag that is still in progress must not survive a step change, or the
    // next step opens with the drop box stuck in its highlighted state.
    setSheetError('');
    setDragOver(false);
  }, []);
  const openProofForm = useCallback(() => {
    // Fetch the member's existing requests so the form can say "you already
    // asked" BEFORE they attach a 2 MB receipt. Without it, a duplicate costs
    // the user a full upload before the server answers 409.
    goToStep('proof');
    setRequestsLoading(true);
    getMyPlanRequests(5)
      .then((data) => setMyRequests(Array.isArray(data.requests) ? data.requests : []))
      .catch(() => setMyRequests([]))
      .finally(() => setRequestsLoading(false));
  }, [goToStep]); // Escape closes the sheet, and the page behind must not scroll under it.
  //
  // The lock is a class, not an inline style: iOS Safari IGNORES
  // `body { overflow: hidden }` for scroll locking (a long-standing WebKit
  // behaviour), so the page behind still moved under the sheet on a phone. The
  // class is a hard `position: fixed` lock, which iOS does honour.
  useEffect(() => {
    if (!checkout) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') closeCheckout();
    };
    // Preserve the scroll offset: `position: fixed` on the body resets scrollTop
    // to 0, which would yank a member who had scrolled to the plan grid back to
    // the top of the page when they closed the sheet.
    document.addEventListener('keydown', onKey);
    const { body } = document;
    const previousOverflow = body.style.overflow;
    const previousPosition = body.style.position;
    const previousTop = body.style.top;
    const previousWidth = body.style.width;
    const scrollY = window.scrollY;
    body.style.overflow = 'hidden';
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.width = '100%';
    body.classList.add('pricing-scroll-locked');
    confirmRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      body.style.overflow = previousOverflow;
      body.style.position = previousPosition;
      body.style.top = previousTop;
      body.style.width = previousWidth;
      body.classList.remove('pricing-scroll-locked');
      window.scrollTo(0, scrollY);
    };
  }, [checkout, closeCheckout]); // The same Escape + scroll lock for the cancel sheet. iOS Safari ignores
  // `body { overflow: hidden }`, so this is a `position: fixed` lock via a class,
  // and it restores the scroll offset on the way out — otherwise closing the
  // sheet would yank a member who had scrolled to the plan grid back to the top.
  useEffect(() => {
    if (!cancelOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') closeCancel();
    };
    document.addEventListener('keydown', onKey);
    const { body } = document;
    const previousOverflow = body.style.overflow;
    const previousPosition = body.style.position;
    const previousTop = body.style.top;
    const previousWidth = body.style.width;
    const scrollY = window.scrollY;
    body.style.overflow = 'hidden';
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.width = '100%';
    body.classList.add('pricing-scroll-locked');
    cancelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      body.style.overflow = previousOverflow;
      body.style.position = previousPosition;
      body.style.top = previousTop;
      body.style.width = previousWidth;
      body.classList.remove('pricing-scroll-locked');
      window.scrollTo(0, scrollY);
    };
  }, [cancelOpen, closeCancel]); // ── The purchase itself ─────────────────────────────────────────────────
  const confirmPurchase = useCallback(async () => {
    // Guard on the in-flight plan, not just the button's disabled state: a
    // second invocation (double-click racing the re-render, a keyboard repeat, a
    // programmatic call) must never create a second subscription. The button is
    // disabled while busy, but that is UI politeness — this is the rule.
    if (!checkout || !catalogue?.selfServe) return;
    if (busyPlan) return;
    const { planId, months } = checkout; // The seat count MUST come from the live `seats` state, not from
    // `checkout.seats`. `checkout` is frozen when the sheet opens, while the
    // stepper writes to `seats` — so reading it from `checkout` bought the
    // opening count: the sheet showed "4 seats · ₱2,796", the confirm button sent
    // 2, and the receipt said ₱1,398. The visitor agreed to one price and was
    // charged another, which is the single worst thing a checkout can do.
    const orderSeats = checkout.planId === TEAM_META.id ? seats : null;
    setBusyPlan(planId);
    setSheetError('');
    try {
      const data = await purchasePlan(planId, months, {
        currency: currencyChoice,
        seats: orderSeats,
      }); // Publish the fresh server snapshot into the shared store FIRST, so the
      // whole app unlocks before this page even closes its sheet. Entitlement
      // changes need no refresh, no re-login.
      publishSubscription(data.subscription);
      setCheckout(null);
      const charged = data?.receipt?.formatted;
      const seatNote = data?.receipt?.seats > 1 ? ` for ${data.receipt.seats} seats` : '';
      showToast(
        'ok',
        charged
          ? `${data.message || `You are now on ${planDisplayName(planId)}.`} Charged ${charged}${seatNote}.`
          : data.message || `You are now on ${planDisplayName(planId)}.`,
      );
    } catch (error) {
      setSheetError(error?.message || 'We could not complete your purchase. Please try again.');
    } finally {
      setBusyPlan(null);
    }
  }, [checkout, catalogue, showToast, busyPlan, currencyChoice, seats]); // ── Proof-of-payment attach ─────────────────────────────────────────────
  //
  // One entry point for BOTH ways of choosing a receipt — the file picker and
  // drag-and-drop — so they cannot diverge in validation, in the size cap, or in
  // the staleness rule. That is also why the drop handler below is a feature
  // rather than a separate code path: desktop members drag a screenshot straight
  // onto the box, and it lands in exactly the same place a picked file does.
  const attachProofFile = useCallback(async (file) => {
    // Take a ticket BEFORE awaiting, so a later file always wins the race.
    if (!file) return;
    const ticket = proofTicket.current + 1;
    proofTicket.current = ticket;
    setProofError('');
    try {
      // A newer attach, a clear, or the sheet closing happened while this read
      // was in flight — the result is stale, so drop it silently rather than
      // overwriting what the member actually chose.
      const read = await readProofFile(file);
      if (proofTicket.current !== ticket) return;
      setProof(read);
    } catch (error) {
      if (proofTicket.current !== ticket) return;
      setProof(null);
      setProofError(error?.message || 'Could not read that file. Please try another image.');
    }
  }, []);
  /** The file picker. Emptied immediately so re-picking the same file works. */
  const pickProof = useCallback(
    (event) => {
      const input = event.target;
      const file = input.files?.[0];
      input.value = '';
      attachProofFile(file);
    },
    [attachProofFile],
  );
  /** Drop a receipt onto the upload box. */
  const dropProof = useCallback(
    (event) => {
      // preventDefault is REQUIRED: without it the browser navigates to the
      // dropped file and the whole SPA is replaced by a PNG.
      event.preventDefault();
      setDragOver(false);
      if (busyPlan) return;
      attachProofFile(event.dataTransfer?.files?.[0]);
    },
    [attachProofFile, busyPlan],
  );
  /** Drop the attached image, and void any read still in flight. */
  const clearProof = useCallback(() => {
    proofTicket.current += 1;
    setProof(null);
    setProofError('');
  }, []); // ── Submit the request for review ───────────────────────────────────────
  const submitRequest = useCallback(async () => {
    // The rule, not the button's disabled state: a second invocation must never
    // create a second request in the admin queue.
    if (!checkout || checkout.step !== 'proof') return;
    if (busyPlan) return;
    if (!proof) {
      setSheetError('Attach a photo or screenshot of your payment to continue.');
      return;
    }
    const { planId, months } = checkout; // Live seat count, not the frozen one on `checkout` — see confirmPurchase. A
    // request that names the wrong seat count is one an admin approves for the
    // wrong amount.
    const orderSeats = planId === TEAM_META.id ? seats : null;
    setBusyPlan(planId);
    setSheetError('');
    try {
      const data = await submitPlanRequest({
        plan: planId,
        months,
        seats: orderSeats,
        currency: currencyChoice,
        reference,
        note: requestNote,
        proof: proof.dataUrl,
      });
      setCheckout(null);
      clearProof();
      setReference('');
      setRequestNote('');
      showToast(
        'ok',
        data?.message ||
          `Your ${planDisplayName(planId)} request was sent. An administrator will review your payment and activate the plan.`,
      );
    } catch (error) {
      setSheetError(error?.message || 'We could not submit your request. Please try again.');
    } finally {
      setBusyPlan(null);
    }
  }, [
    checkout,
    busyPlan,
    proof,
    reference,
    requestNote,
    currencyChoice,
    showToast,
    clearProof,
    seats,
    // ── Derived view models ─────────────────────────────────────────────────
    // The card's bullets and the "Everything in X" preamble are read from the
    // SERVER, which derives them from the entitlement gates themselves. This page
    // used to carry its own copy of both, which is how the pricing page ended up
    // saying "Everything in Pro, plus:" and "3× more usage than Deluxe" after the
    // plans had been renamed — and how one plan's bullets came to differ between
    // the two copies. There is now exactly one list per tier, and it is the same
    // list the gates use.
  ]);
  const cards = useMemo(
    () =>
      PLAN_CARD_ORDER.map((planId) => {
        const meta = PLAN_META[planId];
        const pricing = pricingFor(planId);
        const isCurrent = planId === currentPlanId;
        const isUpgrade = (PLAN_RANK[planId] ?? 0) > currentRank;
        const isDowngrade = (PLAN_RANK[planId] ?? 0) < currentRank;
        const period = yearly ? '/ year' : '/ month';
        const entry = catalogue?.plans?.find((p) => p.id === planId) || null; // The tier this card builds on, named by the server so the name can never
        // be a stale local string. Falls back to the local map only before the
        // catalogue has loaded.
        const inheritedId = entry?.inherits ?? meta.inherits ?? null;
        const inheritedEntry = inheritedId
          ? catalogue?.plans?.find((p) => p.id === inheritedId) || null
          : null;
        const inherited = inheritedEntry
          ? { name: inheritedEntry.label }
          : inheritedId
            ? { name: PLAN_META[inheritedId]?.name }
            : null;
        return {
          planId,
          meta,
          pricing,
          isCurrent,
          isUpgrade,
          isDowngrade,
          period,
          inherited, // Server-derived, already in display order. `ready` distinguishes "this
          // tier genuinely adds nothing" from "the catalogue has not arrived".
          features: entry?.features || null,
          featuresReady: !!entry,
          limits: entry?.limits || [],
        };
      }),
    [currentPlanId, currentRank, pricingFor, yearly, catalogue],
    // The Team band is a separate object on the payload, not an entry in
    // `plans`, so it does not go through `pricingFor`. It used to be read as
    // `catalogue?.team?.pricing || null` and then dereferenced unguarded
    // (`teamPricing.formatted.yearly`) a few lines below, while the section's
    // own guard only checked that `catalogue` existed. So any response without a
    // fully-formed `team.pricing` — an older server, a partial payload, a shape
    // change — threw a TypeError and took the whole page down to a blank
    // screen. Resolve it the same way as a plan: a neutral placeholder that says
    // "—" rather than a made-up number or a crash.
  );
  const teamPricing = useMemo(() => {
    const entry = catalogue?.team?.pricing;
    if (!entry?.formatted) {
      return {
        monthly: null,
        yearly: null,
        monthlyEquivalent: null,
        savedPct: 0,
        formatted: { monthly: '—', yearly: '—', monthlyEquivalent: '—' },
        ready: false,
      };
    }
    return { ...entry, ready: true };
  }, [catalogue]); // The band's bullets and the info columns both quote server-owned facts, so
  // both are built from the catalogue rather than from a local constant. The
  // period length is passed in too: the column says "30 days" because the server
  // says STANDARD_PERIOD_DAYS is 30, not because 30 was typed into a sentence.
  const teamFeatures = catalogue?.team?.features || null;
  const infoColumns = useMemo(
    () => buildInfoColumns(catalogue?.plans || [], catalogue?.standardPeriodDays),
    [catalogue],
  );
  const liveDays = live.permanent ? null : daysLeftFrom(live.end);
  const currentMeta = PLAN_META[currentPlanId];
  // A Team subscription is the Premium tier with more than one seat, so the
  // account is a Team customer exactly when its seat count says so.
  const activeCurrency = catalogue?.currency || 'PHP';
  const liveIsTeam = liveActive && Number(live.seats) > 1;
  // The note under the plan dock: which currency is being charged, and why.
  // It names the currency AND the reason it was chosen, so the summary sheet
  // prints it as-is — an extra "Charged in PHP." prefix in front of it would
  // read the same fact twice, mid-sentence.
  const currencyNote = currencySourceNote({
    currency: activeCurrency,
    source: catalogue?.currencySource,
    country: catalogue?.detectedCountry,
  });
  // Each plan's annual saving is different, so the toggle badge advertises the
  // best one rather than inventing a single flat percentage.
  const bestSaving = useMemo(
    () => Math.max(0, ...(catalogue?.plans || []).map((p) => p.pricing?.savedPct || 0)),
    [catalogue],
    // ── The period meter ─────────────────────────────────────────────────────
    // "30 days remaining" is a number the member has to do arithmetic on. The bar
    // turns it into something they can see running out.
    //
    // The window length is read from the plan's own start and end rather than
    // from `standardPeriodDays`, because buying again EXTENDS the window: a member
    // who has renewed twice has 90 days, not 30, and a bar computed against 30
    // would sit pinned at full for two thirds of its life and then fall off a
    // cliff. Both endpoints come from the same server snapshot the text above the
    // bar uses, so the bar and the sentence cannot disagree.
  );
  const periodMeter = useMemo(() => {
    const standard = Number(catalogue?.standardPeriodDays);
    const fallback = Number.isFinite(standard) && standard > 0 ? Math.round(standard) : 30;
    if (!liveActive) return { days: 0, total: fallback, left: 0, pct: 0, permanent: false };
    if (live.permanent) return { days: 0, total: 0, left: null, pct: 1, permanent: true };
    const startMs = live.start ? new Date(live.start).getTime() : NaN;
    const endMs = live.end ? new Date(live.end).getTime() : NaN;
    const total =
      Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
        ? Math.max(1, Math.round((endMs - startMs) / 86400000))
        : fallback;
    const left = Number.isFinite(liveDays) ? Math.max(0, liveDays) : 0;
    return {
      days: fallback,
      total,
      left,
      pct: Math.max(0, Math.min(1, left / total)),
      permanent: false,
    };
  }, [catalogue, liveActive, live.permanent, live.start, live.end, liveDays]); // The PAID / ADMIN GRANT / FREE answer, in one place. It was previously
  // re-derived from `live.source` at both the chip and its label, which is two
  // chances to render a chip whose words disagree with its colour.
  const sourceTone =
    live.source === 'admin' ? 'admin' : live.source === 'payment' ? 'paid' : 'free';
  const sourceLabel =
    live.source === 'admin' ? 'ADMIN GRANT' : live.source === 'payment' ? 'PAID' : 'FREE';
  return (
    <div className="pricing-page">
      <Navbar />
      <div className="pricing-shell">
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <header className="pricing-hero">
          <span className="pricing-eyebrow">
            <span className="pricing-eyebrow__dot" aria-hidden="true" />
            {catalogue?.standardPeriodDays || 30}-day plans · cancel any time
          </span>
          {/*            `data-text` mirrors the words for the blurred bloom behind the gradient:            `text-shadow` does not render on background-clipped text, so the glow has to            be a duplicated layer.           */}
          <h1 className="pricing-title">
            Choose the plan that fits{' '}
            <span className="pricing-title__accent" data-text="your routine">
              your routine
            </span>
          </h1>
          <p className="pricing-subtitle">
            Every plan includes the health assessment, personalized supplement recommendations and
            daily intake tracking. Paid plans add analytics, report export, priority review and the
            AI assistant.
          </p>
          {/*            The three things the paragraph above just promised, as chips. It repeats            that sentence rather than making a new claim, and it gives a guest — who has            no "your plan" card below — something to read here instead of a gap.           */}
          <ul className="pricing-includes">
            {['Health assessment', 'Personalized recommendations', 'Daily intake tracking'].map(
              (item) => (
                <li key={item}>
                  <CheckIcon size={13} />
                  {item}
                </li>
              ),
            )}
          </ul>
          {isSignedIn && (
            <section
              className={`pricing-current pricing-current--${currentPlanId}`}
              aria-label="Your current plan"
            >
              <div className="pricing-current__main">
                <span className="pricing-current__label">Your plan</span>
                <div className="pricing-current__title">
                  <span className="pricing-current__plan">{currentMeta?.name || 'Free'}</span>
                  <span className={`pricing-chip pricing-chip--${sourceTone}`}>{sourceLabel}</span>
                </div>
                <p className="pricing-current__meta">
                  {liveActive ? (
                    <>
                      <strong>{durationText(live.end, live.permanent)}</strong>
                      {!live.permanent && live.end ? ` · until ${formatDate(live.end)}` : ''}
                    </>
                  ) : (
                    'Every paid plan adds to this — nothing here is locked away.'
                  )}
                </p>
                {/*                  Deliberately does NOT name a cause. An immediate cancellation, an                  administrator removing the plan and a period simply running out all read as                  status 'expired' on this object, and the audit trail that DOES distinguish                  them (`history[].action === 'remove'`, "Cancelled by member.") is admin-only                  by design. The old copy said "Your plan has expired", which told someone who                  had just clicked "End it now" that a period lapsed — untrue, and it reads as                  a billing fault they need to chase. "has ended" is the one wording that                  cannot be wrong.                 */}
                {live.status === 'expired' && (
                  <p className="pricing-current__note">Your plan has ended.</p>
                )}
                {live.layers?.override?.active && (
                  <p className="pricing-current__note">
                    An administrator changed this plan.
                    {live.layers.canRestore
                      ? ' It can be restored to your original paid plan.'
                      : ''}
                  </p>
                )}
              </div>
              {/*                The meter. Hidden entirely for a permanent plan rather than drawn full: a                bar sitting at 100% forever would imply a countdown that does not exist.               */}
              {liveActive && !periodMeter.permanent && periodMeter.total > 0 && (
                <div className="pricing-current__period">
                  <div
                    className="pricing-meter"
                    role="img"
                    aria-label={`${periodMeter.left} of ${periodMeter.total} days remaining`}
                  >
                    <span className="pricing-meter__fill" style={{ '--fill': periodMeter.pct }} />
                  </div>
                  <p className="pricing-current__period-note">
                    <strong>{periodMeter.left}</strong> of {periodMeter.total} days left
                    {liveIsTeam ? ` · ${live.seats} seats` : ''}
                  </p>
                </div>
              )}
              <button
                type="button"
                className="pricing-current__action"
                onClick={() => navigate('/profile?view=billing')}
              >
                Manage billing <ArrowIcon size={14} />
              </button>
            </section>
          )}
        </header>
        {/* ── Plan grid ────────────────────────────────────────────────── */}
        {/*          The title and the two controls share one sticky dock, so switching          Monthly/Yearly never means scrolling back up to see the effect. The caption          sits below the dock, outside it, because it is reference text and does not          need to follow the member down the page.         */}
        <div className="pricing-bar">
          <h2 className="pricing-bar__title">Individual plans</h2>
          <div className="pricing-bar__controls">
            <CurrencyPicker
              currencies={catalogue?.currencies || []}
              active={activeCurrency}
              choice={currencyChoice}
              onChange={changeCurrency}
            />
            <div className="pricing-toggle" role="group" aria-label="Billing period">
              <button
                type="button"
                className="pricing-toggle__btn"
                aria-pressed={!yearly}
                onClick={() => setYearly(false)}
              >
                Monthly
              </button>
              <button
                type="button"
                className="pricing-toggle__btn"
                aria-pressed={yearly}
                onClick={() => setYearly(true)}
              >
                Yearly
                {/*                  Each plan saves a different amount, so the badge names the best one — a                  single flat "Save N%" would misstate the others.                 */}
                <span className="pricing-toggle__save"> Save {bestSaving}% </span>
              </button>
            </div>
          </div>
        </div>
        {/* The currency source, and the one honest sentence about how billing
            behaves. It sits BELOW the dock rather than inside it: it is reference
            text, and pinning it would make the sticky bar taller for something a
            member reads once. */}
        <p className="pricing-bar__note">
          {currencyNote} Switch plans whenever you like — nothing renews on its own.
        </p>
        {loadError ? (
          <div className="pricing-load-error" role="alert">
            <InfoIcon /> <span>{loadError}</span>
            <button
              type="button"
              className="pricing-current__action"
              onClick={() => loadCatalogue({ retry: true })}
            >
              Try again
            </button>
          </div>
        ) : loading || !catalogue ? (
          <div className="pricing-grid" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="pricing-skeleton" />
            ))}
          </div>
        ) : (
          <div className="pricing-grid">
            {cards.map(
              ({
                planId,
                meta,
                pricing,
                isCurrent,
                isUpgrade,
                isDowngrade,
                period,
                inherited,
                features,
                featuresReady,
                limits,
              }) => {
                const busy = busyPlan === planId;
                let ctaLabel = meta.cta;
                if (isCurrent) ctaLabel = 'Your current plan';
                else if (isDowngrade) ctaLabel = `Switch to ${meta.name}`;
                const Glyph = PLAN_GLYPHS[planId] || InfoIcon;
                return (
                  <article
                    key={planId}
                    // The per-tier modifier is what carries the whole colour
                    // system: `--a` and `--a-rgb` are set once by the
                    // `.pricing-card--<id>` rule and read by every child below.
                    className={`pricing-card pricing-card--${planId}${meta.highlight ? ' pricing-card--highlight' : ''}`}
                  >
                    {meta.badge && <span className="pricing-card__badge">{meta.badge}</span>}
                    <div className="pricing-card__head">
                      {/*                        Decoration only: the plan's name is always right beside it, so the glyph is                        never the sole signal.                       */}
                      <span className="pricing-card__glyph">
                        <Glyph />
                      </span>
                      <div className="pricing-card__headings">
                        <h3 className="pricing-card__name">{meta.name}</h3>
                        <p className="pricing-card__tagline">{meta.tagline}</p>
                      </div>
                    </div>
                    {/*                      Prices are the server's FORMATTED strings, not a number this page formatted:                      the conversion, the rounding and the symbol all happen server-side so the                      figure here is byte-for-byte the one the purchase endpoint will quote.                     */}
                    <div className="pricing-card__price">
                      <span className="pricing-card__amount">
                        {yearly ? pricing.formatted.yearly : pricing.formatted.monthly}
                      </span>
                      <span className="pricing-card__period">
                        {planId === 'free' ? '/ month' : period}
                      </span>
                    </div>
                    <p
                      className={`pricing-card__price-note${yearly && pricing.savedPct > 0 ? ' pricing-card__price-note--save' : ''}`}
                    >
                      {planId === 'free'
                        ? 'No payment method required'
                        : yearly
                          ? `${pricing.formatted.monthlyEquivalent}/mo · billed yearly · save ${pricing.savedPct}%`
                          : `Billed monthly · cancel any time`}
                    </p>
                    <button
                      type="button"
                      className={`pricing-cta${isCurrent ? ' pricing-cta--current' : planId === 'free' && isDowngrade ? ' pricing-cta--danger' : meta.highlight ? ' pricing-cta--primary' : ''}`} // The Free card is the one plan that is not bought, so it does
                      // not go through checkout. It is the CANCEL button: pressing
                      // it used to navigate to the dashboard and change nothing,
                      // which is why it read as dead. It now opens the cancel
                      // sheet, where the member picks between ending the plan now
                      // and asking an administrator to review it.
                      onClick={() =>
                        planId === 'free' && isDowngrade ? openCancel() : choosePlan(planId)
                      } // Only the current plan is inert. When billing is switched off
                      // the button stays live and opens the sheet that explains
                      // why — a dead CTA is worse than an honest one.
                      disabled={isCurrent || busy}
                      aria-label={
                        isCurrent
                          ? `${meta.name} — your current plan`
                          : planId === 'free' && isDowngrade
                            ? `Cancel your plan and return to ${meta.name}`
                            : `${ctaLabel}${isUpgrade ? ' (upgrade)' : ''}`
                      }
                    >
                      {busy && <span className="pricing-cta__spinner" aria-hidden="true" />}
                      {busy ? 'Activating…' : ctaLabel}
                      {!busy && !isCurrent && planId !== 'free' && <ArrowIcon size={14} />}
                    </button>
                    <ul className="pricing-features">
                      {inherited && (
                        <li className="pricing-feature pricing-feature--inherited">
                          <CheckIcon />
                          <span>Everything in {inherited.name}, plus:</span>
                        </li>
                      )}
                      {/*                        Server-derived from the entitlement gates. Each bullet names a real, gated                        feature, so a card cannot promise something the account would not actually                        unlock.                       */}
                      {(features || []).map((feature) => (
                        <li key={feature.key} className="pricing-feature">
                          <CheckIcon />
                          <span>
                            {feature.label}
                            {feature.description && (
                              <small className="pricing-feature__desc">{feature.description}</small>
                            )}
                          </span>
                        </li>
                      ))}
                      {/*                        The one limit the product actually enforces, as a real number from the same                        function the gate calls.                       */}
                      {limits.map((limit) => (
                        <li key={limit} className="pricing-feature pricing-feature--limit">
                          <CheckIcon />
                          <span>{limit}</span>
                        </li>
                      ))}
                      {!featuresReady && (
                        <li className="pricing-feature pricing-feature--pending">
                          <span className="pricing-feature__pending-text">
                            Loading what&rsquo;s included…
                          </span>
                        </li>
                      )}
                    </ul>
                  </article>
                );
              },
            )}
          </div>
        )}
        {/*          ── Team band ────────────────────────────────────────────────── A real          purchasable plan, not a "contact us" band: it opens the same checkout as the          cards above, with a seat stepper.         */}
        {catalogue && (
          <section className="pricing-team" aria-label={TEAM_META.name}>
            <div className="pricing-team__body">
              <h2 className="pricing-team__name">
                {TEAM_META.name}
                {/*                  If this account already has a Team subscription, say so on the band —                  otherwise a 10-seat practice sees a "Choose Team" button that looks like it                  would halve them to one seat.                 */}
                {liveActive && liveIsTeam && (
                  <span className="pricing-team__current">
                    {live.seats} seat{live.seats === 1 ? '' : 's'}
                  </span>
                )}
              </h2>
              <p className="pricing-team__tagline">{TEAM_META.tagline}</p>
              <ul className="pricing-team__features">
                {/*                  Server-derived: a seat grants exactly the Premium tier, so the band lists                  that tier's real gated features.                 */}
                {(teamFeatures || []).map((feature) => (
                  <li key={feature}>
                    <CheckIcon size={14} />
                    {feature}
                  </li>
                ))}
                {!teamFeatures && (
                  <li className="pricing-team__pending">Loading what&rsquo;s included…</li>
                )}
              </ul>
            </div>
            <div className="pricing-team__buy">
              <div className="pricing-team__price">
                <div className="pricing-team__amount">
                  {yearly ? teamPricing.formatted.yearly : teamPricing.formatted.monthly}
                </div>
                <div className="pricing-team__unit">
                  {yearly ? 'per seat / year' : 'per seat / month'}
                  {yearly && teamPricing.savedPct > 0 ? ` · save ${teamPricing.savedPct}%` : ''}
                </div>
              </div>
              <button
                type="button"
                className="pricing-cta pricing-cta--primary"
                onClick={() => choosePlan(TEAM_META.id, { isTeam: true })}
                disabled={busyPlan === TEAM_META.id}
                aria-label={`${TEAM_META.cta} — Premium features per seat, from ${teamPricing.formatted.monthly} per seat per month`}
              >
                {busyPlan === TEAM_META.id && (
                  <span className="pricing-cta__spinner" aria-hidden="true" />
                )}
                {busyPlan === TEAM_META.id ? 'Activating…' : TEAM_META.cta}
                {busyPlan !== TEAM_META.id && <ArrowIcon size={14} />}
              </button>
            </div>
          </section>
        )}
        {/* ── Info columns ─────────────────────────────────────────────── */}
        <section className="pricing-info" aria-label="Plan details">
          {infoColumns.map((column) => {
            const Icon = INFO_ICONS[column.icon] || InfoIcon;
            return (
              // The per-column modifier sets `--a` / `--a-rgb`, which tints the
              // icon chip and the link. Three columns in three colours is easier
              // to tell apart than three identical grey cards.
              <article
                key={column.id}
                className={`pricing-info__col pricing-info__col--${column.id}`}
              >
                <span className="pricing-info__icon">
                  <Icon />
                </span>
                <h3 className="pricing-info__title">{column.title}</h3>
                <p className="pricing-info__body">{column.body}</p>
                {/*                  A real link, not a button that navigates. These read as navigation ("Read                  Security & Trust", "Change plan"), and a <button> announcing itself as an                  action breaks the things a link is for: middle-click and Ctrl+click open a                  new tab, a screen reader announces navigation rather than an action, and the                  status bar shows where it goes.                 */}
                <Link className="pricing-info__link" to={column.action.to}>
                  {column.action.label}
                  <ArrowIcon size={13} />
                </Link>
              </article>
            );
          })}
        </section>
      </div>
      {/* ── Checkout / plan-request sheet ─────────────────────────────── */}
      {checkout && catalogue && (
        <CheckoutSheet
          checkout={checkout}
          catalogue={catalogue}
          pricing={checkout.planId === TEAM_META.id ? teamPricing : pricingFor(checkout.planId)}
          isTeam={checkout.planId === TEAM_META.id}
          seats={seats}
          onSeats={setSeats}
          currentPlanId={currentPlanId}
          currentDays={liveDays}
          currentPermanent={live.permanent}
          error={sheetError}
          busy={busyPlan === checkout.planId}
          confirmRef={confirmRef}
          fileInputRef={fileInputRef}
          selfServe={catalogue.selfServe === true}
          proof={proof}
          proofError={proofError}
          dragOver={dragOver}
          onPickProof={pickProof}
          onDropProof={dropProof}
          onDragOverChange={setDragOver}
          onRemoveProof={clearProof}
          reference={reference}
          onReference={setReference}
          note={requestNote}
          onNote={setRequestNote}
          myRequests={myRequests}
          requestsLoading={requestsLoading}
          onStep={goToStep}
          onOpenProof={openProofForm}
          onConfirm={confirmPurchase}
          onSubmitRequest={submitRequest}
          onClose={closeCheckout}
          onContactSupport={() => {
            closeCheckout();
            // Opens the support inbox with the composer ready and "Payment"
            // preselected — somebody asking this from the checkout is asking
            // about a payment, so they should not have to re-type that.
            navigate('/support?new=1&topic=payment');
          }}
        />
      )}
      {/*        ── Cancel sheet ───────────────────────────────────────────────── Mounted        only while `cancelOpen` is true, and only for a member who actually has a        paid plan: an account already on Free has nothing to cancel, and the Free        card is its own "your current plan" in that case, so the button is never a        live cancel control.       */}
      {cancelOpen && isSignedIn && currentPlanId !== 'free' && (
        <CancelSheet
          planName={planDisplayName(currentPlanId)}
          mode={cancelMode}
          onMode={setCancelMode}
          reason={cancelReason}
          onReason={setCancelReason}
          myCancels={myCancels}
          error={cancelError}
          busy={cancelBusy}
          confirmRef={cancelRef}
          onCommit={commitCancel}
          onClose={closeCancel}
        />
      )}
      {toast && (
        <div
          className={`pricing-toast${toast.tone === 'error' ? ' pricing-toast--error' : ''}`}
          role="status"
          aria-live="polite"
        >
          {toast.tone === 'error' ? <InfoIcon size={16} /> : <CheckIcon size={16} />}
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  );
}
/** * Currency selector. * * A native <select> on purpose: it is the one control that is already * keyboard-, screen-reader- and mobile-native everywhere, and a custom listbox * would be a worse version of it. "Auto" is the default entry and hands the * choice back to location detection; picking a currency explicitly always wins * over that, which is what `choice` tracks. */
function CurrencyPicker({ currencies, active, choice, onChange }) {
  // Before the catalogue loads there is nothing to show but the current value —
  // rendering an empty select would look broken rather than loading.
  const list = Array.isArray(currencies) ? currencies : [];
  const value = choice || 'AUTO';
  return (
    <label className="pricing-currency">
      <span className="pricing-currency__label">Currency</span>
      <select
        className="pricing-currency__select"
        value={value}
        onChange={(event) => onChange(event.target.value === 'AUTO' ? null : event.target.value)}
        aria-label="Display currency"
        disabled={list.length === 0}
      >
        <option value="AUTO">Auto ({active})</option>
        {list.map((entry) => (
          <option key={entry.code} value={entry.code}>
            {entry.symbol} {entry.code} — {entry.name}
          </option>
        ))}
      </select>
    </label>
  );
}
/** * Order summary + confirm. * * It states the billing period and what happens to the days already paid for, * because that is the part users get wrong: renewing EXTENDS the window rather * than replacing it, and cancelling keeps access until the end of the period. * * When the deployment has self-serve billing switched off it shows the same * summary plus a plain explanation and the route that does work, instead of a * confirm button that cannot succeed. */
/** * * * The checkout sheet — two steps, one dialog. * * STEP 1 summary What is * being bought, for how long, for how much, and what * happens to the days * already paid for. That is the part * users get wrong: renewing EXTENDS the * window rather than * replacing it, and a permanent plan is not reset. * STEP * 2 proof Payment reference, a note, and the receipt image. Submitting * * queues the request for an administrator; it grants nothing * on its own, and * the member is told so in as many words. * * Which step 1 offers depends on * the deployment. `selfServe` on → confirm * instantly, with the proof form * one click away for anyone who paid by bank * transfer. `selfServe` off (the * default — it fails closed) → the proof form is * the primary action, because * an administrator approving a receipt is the ONLY * route to a paid plan on * that deployment. Either way there is never a button * that cannot succeed. */ function CheckoutSheet({
  checkout,
  catalogue,
  pricing,
  isTeam,
  seats,
  onSeats,
  currentPlanId,
  currentDays,
  currentPermanent,
  error,
  busy,
  confirmRef,
  fileInputRef,
  selfServe,
  proof,
  proofError,
  dragOver,
  onPickProof,
  onDropProof,
  onRemoveProof,
  onDragOverChange,
  reference,
  onReference,
  note,
  onNote,
  myRequests,
  requestsLoading,
  onStep,
  onOpenProof,
  onConfirm,
  onSubmitRequest,
  onClose,
  onContactSupport,
}) {
  const { planId, months, step } = checkout; // TEAM. The per-seat unit price and the N-seat total are BOTH server strings;
  // this page never multiplies money. It used to look the seat count up in the
  // catalogue's pre-computed `seatTotals` and fall back to the PER-SEAT price
  // when the count was not one of the presets — so a "+1" step, or any typed
  // number, showed "₱699" for a 11-seat order. The exact total is requested from
  // the server instead; the pre-computed rows are only the instant answer while
  // that request is in flight.
  //
  // The state and its effect sit ABOVE the early return below: a hook after a
  // conditional return is not called on every render, and React tears the tree
  // down when the hook order changes between renders.
  // { seats, total, perSeat }
  const [exactTotal, setExactTotal] = useState(null);
  const seatIsPrecomputed = (pricing?.seatTotals || []).some((row) => row.seats === seats);
  useEffect(() => {
    // Not Team, or already known with no round-trip: nothing to ask for.
    if (!isTeam || !planId || seatIsPrecomputed) return undefined;
    // A short debounce, so holding "+" does not fire a request per seat.
    let live = true;
    const timer = window.setTimeout(() => {
      quotePlan(planId, { months, seats, currency: catalogue.currency })
        .then((data) => {
          // `live` discards a reply that arrived after the sheet closed or the
          // seat count moved on; the `seats` field it carries is what the reader
          // matches against, so a slow reply for 3 seats cannot land on a sheet
          // now showing 40.
          if (!live || !data) return;
          setExactTotal({
            seats: data.seats,
            total: data.formatted,
            perSeat: data.perSeatFormatted,
          });
        })
        .catch(() => {
          /* leave the placeholder; a wrong figure is worse */
        });
    }, 180);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [isTeam, planId, seats, months, seatIsPrecomputed, catalogue?.currency]); // Team has no entry in PLAN_META (it is not a tier), so it renders from
  // TEAM_META — same shape, so nothing below has to special-case it.
  const meta = PLAN_META[planId] || (isTeam ? TEAM_META : null);
  // The total is the server's formatted string for this exact period, so the
  // figure the visitor confirms is the figure the purchase endpoint charges.
  if (!meta) return null;
  const perSeat = months > 1 ? pricing?.formatted?.yearly : pricing?.formatted?.monthly;
  const instantSeatTotal = isTeam
    ? (pricing?.seatTotals || []).find((row) => row.seats === seats)
    : null;
  const total = isTeam
    ? (exactTotal && exactTotal.seats === seats && exactTotal.total) ||
      (instantSeatTotal
        ? months > 1
          ? instantSeatTotal.yearly
          : instantSeatTotal.monthly
        : null) || // Nothing to show yet — say so rather than print a number that might be
      // wrong. A wrong total is worse than a missing one.
      '—'
    : months > 1
      ? pricing.formatted.yearly
      : pricing.formatted.monthly;
  const perSeatShown = isTeam
    ? exactTotal && exactTotal.seats === seats
      ? exactTotal.perSeat
      : perSeat
    : null;
  const renewing = currentPlanId !== 'free';
  const periodDays = catalogue.standardPeriodDays || 30;
  const afterDays =
    renewing && !currentPermanent && Number.isFinite(currentDays)
      ? currentDays + months * periodDays
      : // Presets come from the server's own list, so the quick-pick buttons and the
        // bounds the server enforces can never disagree.
        months * periodDays;
  const seatPresets = (pricing?.seatTotals || []).map((row) => row.seats);
  const seatMin = TEAM_META.minSeats;
  // A request already waiting for THIS plan. One open request per plan is the
  // server's rule, so the form says so here instead of bouncing a 409 back
  // after the upload.
  const seatMax = Math.min(TEAM_META.maxSeats, catalogue.team?.maxSeats || TEAM_META.maxSeats);
  const openForPlan = (myRequests || []).find(
    (row) =>
      row.plan === (isTeam ? TEAM_META.tier : planId) &&
      row.isTeam === isTeam &&
      row.status === 'pending',
  );
  const otherOpen = (myRequests || []).filter(
    (row) =>
      row.status === 'pending' &&
      !(row.plan === (isTeam ? TEAM_META.tier : planId) && row.isTeam === isTeam),
  );
  // The action bar, as data. Derived in one place so the buttons that render
  // and the layout class that arranges them can never come from two different
  // conditions — which is exactly how the default (non-self-serve) summary ended
  // up wrapping "Upload proof of payment" across three lines. See
  // sheetActions.js.
  const atProofStep = step === 'proof';

  // "How do I actually pay?" — as data, because the copy and the route have to
  // agree. This sheet used to say "send us your payment receipt and an
  // administrator will check it" without ever saying WHERE to send it, and this
  // deployment has no payment destination configured at all, so the screen was
  // asking for proof of a payment nobody could make.
  //
  // `catalogue.payment` is server-owned and fails CLOSED: an absent payload
  // means there is nowhere to send money, and buildProofCopy then offers the
  // administrator route instead of a transfer.
  const payment = catalogue?.payment || null;
  const proofCopy = buildProofCopy({
    planName: meta.name,
    selfServe,
    payment,
  });

  // WHERE TO SEND IT — shown on BOTH steps.
  //
  // Step 1 needs it so the member can decide before committing, and step 2
  // needs it because that is where they are actually about to pay: the receipt
  // upload sits directly below, and a member who has to scroll back a step to
  // find the account number will simply not pay.
  //
  // Rendered only when the server says a destination exists. An account number
  // with no way to reach it is not an answer — and when there is no destination
  // the copy says so plainly, because the alternative is inviting a payment
  // this deployment cannot receive and then leaving the member waiting on an
  // approval nobody can verify.
  const payToBlock = selfServe ? null : (
    proofCopy.detailRows.length > 0 ? (
      <div className="pricing-payto">
        <p className="pricing-payto__head">{proofCopy.headline}</p>
        <dl className="pricing-payto__list">
          {proofCopy.detailRows.map((row) => (
            <div key={row.label} className="pricing-payto__row">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
        {proofCopy.instructions && (
          <p className="pricing-payto__how">{proofCopy.instructions}</p>
        )}
        {proofCopy.referenceHint && (
          <p className="pricing-payto__ref">
            <strong>Reference:</strong> {proofCopy.referenceHint}
          </p>
        )}
      </div>
    ) : (
      <p className="pricing-payto pricing-payto--none" role="status">
        {proofCopy.reason
          || 'There is nowhere to send a payment on this deployment yet — ask an administrator to activate the plan for you.'}
      </p>
    )
  );

  const actions = buildSheetActions({
    step,
    selfServe,
    planName: meta.name,
    busy, // The proof step's submit is meaningless with no receipt attached, and
    // pointless while the same plan already has a request open.
    canSubmit: !!proof && !openForPlan,
  });
  return (
    <div className="pricing-overlay" onClick={onClose}>
      <div
        className="pricing-sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pricing-sheet-title" // The body is the scroll container, not the page, so only one scroll
        // chain is in play. Without this, a touch drag that starts over the
        // receipt preview also scrolls the page behind the overlay.
        onTouchMove={(e) => {
          if (e.cancelable) e.stopPropagation();
        }}
      >
        <div className="pricing-sheet__head">
          <div>
            <p className="pricing-sheet__eyebrow">
              {atProofStep
                ? 'Proof of payment'
                : selfServe
                  ? 'Confirm your plan'
                  : 'Request this plan'}
            </p>
            <h2 className="pricing-sheet__title" id="pricing-sheet-title">
              {meta.name}
            </h2>
            {/*              A two-line progress marker. It is the only way the member can tell "I am              looking at step 2" from "the button did nothing".             */}
            {!selfServe && (
              <p className="pricing-sheet__steps" aria-hidden="true">
                <span className={atProofStep ? 'is-done' : 'is-current'}>1 · Review</span>
                <span className="pricing-sheet__step-arrow">→</span>
                <span className={atProofStep ? 'is-current' : ''}>2 · Proof</span>
              </p>
            )}
          </div>
          <button
            type="button"
            className="pricing-sheet__close"
            onClick={onClose}
            aria-label="Close"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="pricing-sheet__body">
          {!atProofStep && (
            <>
              {/*                ── Seat picker (Team only) ── Team is priced per seat, so the seat count IS                the order. A stepper plus the server's own preset list covers both the                common cases and the awkward one, without turning this into a spreadsheet.               */}
              {isTeam && selfServe && (
                <div className="pricing-seats">
                  <div className="pricing-seats__head">
                    <span className="pricing-seats__label" id="pricing-seats-label">
                      How many seats?
                    </span>
                    <span className="pricing-seats__hint">
                      Each seat is a full {PLAN_LABELS[TEAM_META.tier]} account
                    </span>
                  </div>
                  <div className="pricing-seats__row">
                    <button
                      type="button"
                      className="pricing-seats__step"
                      onClick={() => onSeats(Math.max(seatMin, seats - 1))}
                      disabled={seats <= seatMin}
                      aria-label="Remove one seat"
                    >
                      &minus;
                    </button>
                    <input
                      type="number"
                      className="pricing-seats__input"
                      value={seats}
                      min={seatMin}
                      max={seatMax}
                      step={1}
                      onChange={(event) => {
                        // While the field is being emptied or mid-typing, keep the
                        // last good value rather than snapping to the minimum —
                        // otherwise deleting "10" to type "25" resets it to 2.
                        const next = Number(event.target.value);
                        if (!Number.isFinite(next)) return;
                        onSeats(Math.max(seatMin, Math.min(seatMax, Math.round(next))));
                      }}
                      aria-labelledby="pricing-seats-label"
                    />
                    <button
                      type="button"
                      className="pricing-seats__step"
                      onClick={() => onSeats(Math.min(seatMax, seats + 1))}
                      disabled={seats >= seatMax}
                      aria-label="Add one seat"
                    >
                      +
                    </button>
                  </div>
                  {seatPresets.length > 0 && (
                    <div
                      className="pricing-seats__presets"
                      role="group"
                      aria-label="Common seat counts"
                    >
                      {seatPresets.map((count) => (
                        <button
                          key={count}
                          type="button"
                          className={`pricing-seats__preset${count === seats ? ' pricing-seats__preset--on' : ''}`}
                          onClick={() => onSeats(count)}
                          aria-pressed={count === seats}
                        >
                          {count}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="pricing-summary">
                <div className="pricing-summary__row">
                  <span>Billing period</span>
                  <strong>
                    {months} month{months === 1 ? '' : 's'}
                    {months > 1 ? ' (up front)' : ''}
                  </strong>
                </div>
                {isTeam && selfServe && (
                  <>
                    <div className="pricing-summary__row">
                      <span>Seats</span>
                      <strong>
                        {seats} × {PLAN_LABELS[TEAM_META.tier]}
                      </strong>
                    </div>
                    <div className="pricing-summary__row">
                      <span>Price per seat</span>
                      <strong>
                        {perSeatShown || perSeat} / {months > 1 ? 'year' : 'month'}
                      </strong>
                    </div>
                  </>
                )}
                <div className="pricing-summary__row">
                  <span>Access granted</span> <strong>{months * periodDays} days</strong>
                </div>
                {renewing && (
                  <div className="pricing-summary__row">
                    <span>{currentPermanent ? 'Currently' : 'Days already paid'}</span>
                    <strong>
                      {currentPermanent ? 'Permanent plan' : `${currentDays ?? 0} days`}
                    </strong>
                  </div>
                )}
                <div className="pricing-summary__total">
                  <span>
                    {isTeam && selfServe
                      ? `Total (${seats} seat${seats === 1 ? '' : 's'})`
                      : 'Total'}
                  </span>
                  <span className="pricing-summary__amount">{total}</span>
                </div>
                <p className="pricing-summary__currency">
                  {/*                    The note already names the currency AND says why it was chosen, so the old                    "Charged in PHP." prefix made this read "Charged in PHP. Prices in PHP, your                    chosen currency." — the same fact twice, with the repetition landing in the                    middle of the sentence.                   */}
                  {currencySourceNote({
                    currency: catalogue.currency,
                    source: catalogue.currencySource,
                    country: catalogue.detectedCountry,
                  })}
                </p>
              </div>
              <p className="pricing-sheet__note">
                <InfoIcon size={15} />
                <span>
                  {/*                    Self-serve says only what happens on confirm. Everything else comes from                    buildProofCopy, which knows whether there is somewhere to send money at all                    — the old copy here promised to check a receipt while never saying where to                    send it, so a member had no way to pay.                   */}
                  {selfServe
                    ? isTeam
                      ? `${seats} seats, each a full ${PLAN_LABELS[TEAM_META.tier]} account, for ${months * periodDays} days. ` +
                        'Adjust the seat count any time — the total above updates with it.'
                      : renewing
                        ? `This extends your subscription — you will have about ${afterDays} days of access in total. Nothing you have already paid for is removed.`
                        : `You will have ${months * periodDays} days of access from today, and your features unlock immediately.`
                    : proofCopy.body}
                </span>
              </p>

              {payToBlock}
            </>
          )}
          {/* ── Step 2: proof of payment ───────────────────────────────── */}
          {atProofStep && (
            <div className="pricing-proof">
              {/*                The plan being requested stays on screen at every step: the whole point of a                receipt is that it is checked against a price, and "which plan?" must never                require remembering step 1.               */}
              <div className="pricing-proof__summary">
                <span>
                  {isTeam ? `${seats} × ${PLAN_LABELS[TEAM_META.tier]} (Team)` : meta.name}
                </span>
                <strong>{total}</strong>
                <span className="pricing-proof__term">
                  {months} month{months === 1 ? '' : 's'} · {months * periodDays} days
                </span>
              </div>
              {/* The destination, directly above the upload box — this is where
                  the member is about to pay, so the account details must be on
                  this step and not only on the previous one. */}
              {payToBlock}
              {requestsLoading && (
                <p className="pricing-sheet__note">Checking for an existing request…</p>
              )}
              {openForPlan && (
                <p className="pricing-sheet__note pricing-sheet__note--warn" role="status">
                  <InfoIcon size={15} />
                  <span>
                    You already have a {openForPlan.planLabel || meta.name} request waiting for
                    review
                    {openForPlan.createdAt ? ` since ${formatDate(openForPlan.createdAt)}` : ''}. An
                    administrator will get to it shortly — sending another would only slow things
                    down. You can follow it under Manage billing.
                  </span>
                </p>
              )}
              {otherOpen.length > 0 && (
                <p className="pricing-sheet__note" role="status">
                  <InfoIcon size={15} />
                  <span>
                    You also have {otherOpen.length === 1 ? ' a ' : ' '}
                    {otherOpen.length} other {otherOpen.length === 1 ? ' request' : ' requests'}
                    waiting for review
                    {otherOpen.length === 1 && otherOpen[0].planLabel
                      ? ` (${otherOpen[0].planLabel})`
                      : ''}
                    . You can still send this one.
                  </span>
                </p>
              )}
              <div className="pricing-field">
                <label className="pricing-field__label" htmlFor="pricing-reference">
                  Payment reference <span className="pricing-field__opt">optional</span>
                </label>
                <input
                  id="pricing-reference"
                  className="pricing-field__input"
                  type="text"
                  maxLength={80}
                  autoComplete="off"
                  value={reference}
                  onChange={(e) => onReference(e.target.value)}
                  placeholder="Transfer or receipt number"
                  disabled={busy}
                />
              </div>
              <div className="pricing-field">
                <label className="pricing-field__label" htmlFor="pricing-note">
                  Note for the reviewer <span className="pricing-field__opt">optional</span>
                </label>
                <textarea
                  id="pricing-note"
                  className="pricing-field__input pricing-field__input--area"
                  rows={2}
                  maxLength={500}
                  value={note}
                  onChange={(e) => onNote(e.target.value)}
                  placeholder="Anything that helps us match the payment"
                  disabled={busy}
                />
              </div>
              <div className="pricing-field">
                <span className="pricing-field__label">
                  Proof of payment <span className="pricing-field__req">required</span>
                </span>
                {proof ? (
                  <div className="pricing-upload pricing-upload--done">
                    <img
                      className="pricing-upload__preview"
                      src={proof.dataUrl}
                      alt="The payment receipt you selected"
                    />
                    <div className="pricing-upload__meta">
                      <span className="pricing-upload__name">
                        {prettyBytes(proof.bytes)} ·{proof.mime.replace('image/', '').toUpperCase()}
                      </span>
                      <button
                        type="button"
                        className="pricing-upload__replace"
                        onClick={onRemoveProof}
                        disabled={busy}
                      >
                        Remove
                      </button>
                    </div>
                  </div> // A <button> rather than a <label>: it is reachable by keyboard,
                ) : (
                  // shows a focus ring, and behaves the same in the Android
                  // webview, where a bare file input styled with opacity:0 often
                  // refuses to open the picker at all. It is also the drop target.
                  <button
                    type="button"
                    className={`pricing-upload${proofError ? ' pricing-upload--error' : ''}${dragOver ? ' pricing-upload--over' : ''}`}
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (!busy) onDragOverChange(true);
                    }}
                    onDragEnter={(e) => {
                      e.preventDefault();
                      if (!busy) onDragOverChange(true);
                    }}
                    onDragLeave={(e) => {
                      // Only clear when the pointer actually leaves the box. React
                      // fires dragleave for every child element crossed, so
                      // clearing unconditionally makes the highlight flicker as
                      // the cursor moves over the icon and the labels.
                      if (e.currentTarget.contains(e.relatedTarget)) return;
                      onDragOverChange(false);
                    }}
                    onDrop={onDropProof}
                    onDragEnd={() => onDragOverChange(false)}
                    disabled={busy}
                  >
                    <svg
                      width="26"
                      height="26"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" /> <path d="m21 15-5-5L5 21" />
                    </svg>
                    <span className="pricing-upload__cta">
                      {dragOver ? 'Drop your receipt here' : 'Choose a screenshot or photo'}
                    </span>
                    <span className="pricing-upload__hint">
                      PNG, JPEG or WebP · up to 2 MB · or drop it here
                    </span>
                  </button>
                )}
                {/*                  The native input is never rendered: a styled button that opens it is                  keyboard-reachable, focus-visible and behaves the same on desktop and inside                  the Android webview, which a bare <input type=file> styled with opacity:0                  does not.                 */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={PROOF_ACCEPT}
                  onChange={onPickProof}
                  className="pricing-file-native"
                  tabIndex={-1}
                  aria-hidden="true"
                />
                {proofError && (
                  <p className="pricing-field__error" role="alert">
                    {proofError}
                  </p>
                )}
              </div>
              <p className="pricing-sheet__note">
                <InfoIcon size={15} />
                <span>
                  Make sure the whole receipt is visible, including the amount and the reference.
                  Submitting this does not activate anything on its own — an administrator confirms
                  the payment first, and you will get a notification the moment your plan is live.
                </span>
              </p>
            </div>
          )}
          {error && (
            <p className="pricing-sheet__note pricing-sheet__note--error" role="alert">
              <InfoIcon size={15} /> <span>{error}</span>
            </p>
          )}
        </div>
        {/*          The actions are a SIBLING of the body, not a child of it — and that is the          entire reason the primary button is always reachable. The body is the only          scroll container, so on a short viewport the receipt fields scroll          underneath a pinned action bar instead of carrying "Send for approval"          off-screen with them.         */}
        {/*          Rendered from `sheetActions.buildSheetActions` rather than written out per          branch, so the NUMBER of buttons and the layout that depends on that number          cannot drift apart. The old hand-written condition (`selfServe &&          !atProofStep`) only flagged the self-serve summary — and self-serve is off          by default, so the DEFAULT path squeezed "Upload proof of payment" into a          third of this bar and wrapped it across three lines. See sheetActions.js.         */}
        <div className={actionBarClassName(actions)}>
          {actions.map((item) => {
            const handleClick = () => {
              switch (item.action) {
                case 'close':
                  onClose();
                  break;
                case 'support':
                  onContactSupport();
                  break;
                case 'step:summary':
                  onStep('summary');
                  break;
                case 'step:proof':
                  onOpenProof();
                  break;
                case 'confirm':
                  onConfirm();
                  break;
                case 'submit':
                  onSubmitRequest();
                  break;
                default:
                  break;
              }
            };
            return (
              <button
                key={item.key}
                type="button" // Only the primary takes the ref: initial focus and the busy
                // spinner both belong to the committing action.
                ref={item.kind === KIND_PRIMARY ? confirmRef : null}
                className={`pricing-cta${item.kind === KIND_PRIMARY ? ' pricing-cta--primary' : ' pricing-cta--ghost'}`}
                onClick={handleClick}
                disabled={item.disabled === true || busy}
              >
                {item.kind === KIND_PRIMARY && busy && (
                  <span className="pricing-cta__spinner" aria-hidden="true" />
                )}
                {item.kind === KIND_PRIMARY && busy && item.busyLabel ? item.busyLabel : item.label}
                {item.arrow && <ArrowIcon size={14} />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
/** * * * The cancel sheet — returning to Free. * * This exists because the Free * card's button used to do nothing at all: it * navigated to the dashboard and * left the paid plan exactly as it was. A member * who pressed it was told, by * the absence of any change, that cancelling was * not something the product * could do. * * TWO DOORS, AND THEY ARE NOT THE SAME PROMISE * * -------------------------------------------- * "Ask an administrator" — * nothing changes until a human approves. The plan * keeps working the whole * time. * "End it now" — the paid plan is stripped the moment it is * * confirmed, and the days already paid for are not * refunded. * * The choice * is a radio, and the commit button renames itself to match * (see * cancelSheetActions.js). That is deliberate: a button reading "Confirm" * * over two options with opposite consequences is a button that lies to whoever * * cannot tell the options apart, and "immediate" is not a word that explains * * itself. */
function CancelSheet({
  planName,
  mode,
  onMode,
  reason,
  onReason,
  myCancels,
  error,
  busy,
  confirmRef,
  onCommit,
  onClose,
}) {
  // A review request already open means the server would answer 409, so the
  // sheet says so here rather than letting the member find out by pressing.
  const pendingReview = (myCancels || []).some((row) => row && row.status === 'pending'); // The bar, as data — one source for the buttons and for their layout.
  const actions = buildCancelActions({
    mode,
    planName,
    busy,
    alreadyPending: pendingReview,
    canCancel: true,
  });
  const copy = CANCEL_MODE_COPY[mode] || CANCEL_MODE_COPY[CANCEL_MODE_REVIEW];
  return (
    <div className="pricing-overlay" onClick={onClose}>
      <div
        className="pricing-sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-sheet-title"
        onTouchMove={(e) => {
          if (e.cancelable) e.stopPropagation();
        }}
      >
        <div className="pricing-sheet__head">
          <div>
            <p className="pricing-sheet__eyebrow">Cancel your plan</p>
            <h2 className="pricing-sheet__title" id="cancel-sheet-title">
              Return to Free
            </h2>
          </div>
          <button
            type="button"
            className="pricing-sheet__close"
            onClick={onClose}
            aria-label="Close"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="pricing-sheet__body">
          <div className="pricing-cancel">
            <p className="pricing-cancel__lede">
              You are on <strong>{planName}</strong>. Choose how you want to end it — the two
              options are not interchangeable, and one of them stops your access immediately.
            </p>
            <fieldset className="pricing-cancel__options" disabled={busy}>
              <legend className="pricing-cancel__legend">How should this be handled?</legend>
              {CANCEL_MODES.map((option) => {
                const optionCopy = CANCEL_MODE_COPY[option];
                // The immediate door is the destructive one, and it says so in
                // colour as well as words — so the member who skims the sheet
                // still sees which one takes effect now.
                const selected = mode === option;
                const isImmediate = option === CANCEL_MODE_IMMEDIATE;
                return (
                  <label
                    key={option}
                    className={`pricing-cancel__option${selected ? ' is-selected' : ''}${isImmediate ? ' pricing-cancel__option--now' : ''}`}
                  >
                    <input
                      type="radio"
                      name="cancel-mode"
                      value={option}
                      checked={selected}
                      onChange={() => onMode(option)}
                    />
                    <span className="pricing-cancel__option-body">
                      <span className="pricing-cancel__option-label">{optionCopy.label}</span>
                      <span className="pricing-cancel__option-note">{optionCopy.consequence}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            {pendingReview && (
              <p className="pricing-cancel__note">
                You already have a cancellation waiting for review. We will let you know when an
                administrator has looked at it.
              </p>
            )}
            <label className="pricing-cancel__reason-label" htmlFor="cancel-reason">
              Anything you want us to know? <span>(optional)</span>
            </label>
            <textarea
              id="cancel-reason"
              className="pricing-cancel__reason"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(event) => onReason(event.target.value)}
              placeholder={
                mode === CANCEL_MODE_IMMEDIATE
                  ? 'What made you end it now?'
                  : 'Tell us why, if you would like to.'
              }
              disabled={busy}
            />
            {error && <p className="pricing-sheet__note pricing-sheet__note--error">{error}</p>}
          </div>
        </div>
        <div className={cancelActionBarClassName(actions)}>
          {actions.map((item) => (
            <button
              key={item.key}
              type="button"
              ref={item.kind === KIND_PRIMARY ? confirmRef : null}
              className={`pricing-cta${item.kind === KIND_PRIMARY ? (mode === CANCEL_MODE_IMMEDIATE ? ' pricing-cta--danger' : ' pricing-cta--primary') : ' pricing-cta--ghost'}`}
              onClick={() => {
                if (item.action === 'close') onClose();
                else onCommit();
              }}
              disabled={item.disabled === true || busy}
            >
              {item.kind === KIND_PRIMARY && busy && (
                <span className="pricing-cta__spinner" aria-hidden="true" />
              )}
              {item.kind === KIND_PRIMARY && busy && item.busyLabel ? item.busyLabel : item.label}
            </button>
          ))}
        </div>
        <p className="pricing-cancel__sr" aria-live="polite">
          {copy.consequence}
        </p>
      </div>
    </div>
  );
}
