import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import { getHistory, deleteAssessment, checkFeature, getToken } from '../api';
import { exportResultsToPDF } from '../utils/exportPDF';
import { PLAN_LABELS, historyLimitForStoredPlan } from '../utils/plan';
import { safeUrl } from '../utils/safeUrl';
import { useSubscription, SUBSCRIPTION_EVENT } from '../hooks/useSubscription';
import UpgradeModal from '../Components/UpgradeModal/UpgradeModal';
import './HistoryPage.css';

// Normalize special characters that may render as ? in some environments
function fixChars(str) {
  if (!str) return str;
  return String(str)
    // Fix corrupted em/en dash stored as literal '?' in DB (e.g. "Week 1 ? Build", "Hotline ? Call")
    .replace(/([a-zA-Z0-9])\s?\?\s?([a-zA-Z0-9])/g, '$1 - $2')
    // Standard Unicode em/en dash
    .replace(/[\u2013\u2014]/g, ' - ')
    // Smart quotes
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    // Ellipsis
    .replace(/\u2026/g, '...')
    // Strip remaining unsafe non-ASCII (keep tab/LF/CR + printable Latin-1)
    // eslint-disable-next-line no-control-regex -- character class intentionally covers control range
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '');
}

// Detect placeholder/template evidence text the AI failed to fill in
function isPlaceholderEvidence(text) {
  if (!text) return true;
  const t = text.toLowerCase();
  return (
    t.includes('author et al') ||
    t.includes('(year)') ||
    t.includes('xxxxxxx') ||
    t.includes('source 2 if applicable') ||
    t.includes('brief finding') ||
    t.includes('journal name') ||
    t.includes('cite 1-2') ||
    t.length < 15
  );
}

const priorityColor = { High: '#16a34a', Medium: '#d97706', Low: '#374151' };

const MS_PER_DAY = 86400000;

// ── View helpers (module scope so the memos below have no unstable deps) ──

function getExpirationDate(item) {
  if (!item || item.priority === 'Priority') return null; // flagged items never expire
  if (item.expiresAt) {
    const stored = new Date(item.expiresAt);
    if (!Number.isNaN(stored.getTime())) return stored;
  }
  const createdAt = new Date(item.createdAt);
  if (Number.isNaN(createdAt.getTime())) return null;
  // Fallback: exactly 5 calendar years from creation — the same advance the
  // server's expiryFrom() writes, so both render the identical timestamp.
  const expirationDate = new Date(createdAt);
  expirationDate.setFullYear(expirationDate.getFullYear() + 5);
  return expirationDate;
}

// Expired assessments stay readable but are retired from active views.
// Priority assessments never expire while flagged.
function isExpired(item, now) {
  if (!item || item.priority === 'Priority') return false;
  const exp = getExpirationDate(item);
  if (!exp || Number.isNaN(exp.getTime())) return false;
  const ref = now ? new Date(now).getTime() : Date.now();
  return exp.getTime() <= ref;
}

function fmt(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// Whole days left before a record retires (null when it never expires).
function daysLeft(item, now) {
  const exp = getExpirationDate(item);
  if (!exp) return null;
  const ref = now ? new Date(now).getTime() : Date.now();
  return Math.ceil((exp.getTime() - ref) / MS_PER_DAY);
}

function relativeTime(dateStr, now) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  const ref = now ? new Date(now).getTime() : Date.now();
  const diff = ref - d.getTime();
  // A record dated in the future means clock skew, not a negative age.
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diff / MS_PER_DAY);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    return months === 1 ? '1 month ago' : `${months} months ago`;
  }
  const years = Math.floor(days / 365);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}

// The one-line headline shown on a collapsed card.
function cardTitle(item) {
  if (item.symptoms?.length > 0 && !item.symptoms.includes('None')) {
    return item.symptoms.slice(0, 2).join(', ')
      + (item.symptoms.length > 2 ? ` +${item.symptoms.length - 2} more` : '');
  }
  if (item.healthGoals?.length > 0) return item.healthGoals.slice(0, 2).join(', ');
  return 'General Wellness Assessment';
}

const ACTIVITY_LABELS = {
  Sedentary: 'Sedentary / No Exercise',
  Light:     'Light (1–3 days/week)',
  Moderate:  'Moderate (3–5 days/week)',
  Very:      'Very Active (6–7 days/week)',
};

// Map generic food category words to specific examples
const FOOD_SPECIFICS = {
  'fatty fish':       'fatty fish (salmon, tuna, sardines, mackerel)',
  'leafy greens':     'leafy greens (spinach, kale, Swiss chard)',
  'leafy green':      'leafy greens (spinach, kale, Swiss chard)',
  'nuts':             'nuts (almonds, cashews, walnuts, pumpkin seeds)',
  'dairy':            'dairy (Greek yogurt, cheddar cheese, whole milk)',
  'dairy products':   'dairy (Greek yogurt, cheddar cheese, whole milk)',
  'citrus':           'citrus (oranges, grapefruit, kiwi)',
  'citrus fruits':    'citrus (oranges, grapefruit, kiwi)',
  'legumes':          'legumes (lentils, chickpeas, black beans)',
  'whole grains':     'whole grains (oats, brown rice, quinoa)',
  'lean meats':       'lean meats (chicken breast, turkey, lean beef)',
  'lean meat':        'lean meats (chicken breast, turkey, lean beef)',
  'red meat':         'red meat (beef, lamb, bison)',
  'shellfish':        'shellfish (oysters, clams, crab, shrimp)',
  'seeds':            'seeds (pumpkin seeds, sunflower seeds, chia seeds)',
  'berries':          'berries (blueberries, strawberries, raspberries)',
  'cruciferous vegetables': 'cruciferous vegetables (broccoli, Brussels sprouts, cauliflower)',
  'organ meats':      'organ meats (beef liver, chicken liver)',
  'fermented foods':  'fermented foods (kefir, kimchi, sauerkraut, miso)',
};

function expandFoodText(text) {
  if (!text) return text;
  // Strip sentence fragments first
  let cleaned = text
    .replace(/,?\s*(such as|which are|are naturally|naturally rich|found in|including)[^,;]*/gi, '')
    .replace(/,?\s*are\s+[a-z].*$/gi, '')
    .trim()
    .replace(/,\s*$/, '');
  cleaned = cleaned || text;
  // Then expand generic category words
  for (const [key, expanded] of Object.entries(FOOD_SPECIFICS)) {
    const regex = new RegExp(`\\b${key}\\b`, 'gi');
    cleaned = cleaned.replace(regex, expanded);
  }
  return cleaned;
}

// ── Client-side evidence/foods/sideEffects fallback ───────────────────────
// Mirrors the server-side inferEvidence/inferFoods/inferSideEffects so that
// old DB records (saved before server enrichment was added) still show data.
const EVIDENCE_MAP = {
  magnesium:    'Supported by NIH studies on magnesium and sleep quality (PMID: 23853635) and multiple RCTs on magnesium deficiency.',
  'vitamin d':  'Supported by NIH Vitamin D fact sheet and Endocrine Society guidelines on Vitamin D deficiency.',
  'vitamin b12':'Supported by NIH B12 fact sheet; methylcobalamin shown superior in neurological studies (PMID: 15208835).',
  b12:          'Supported by NIH B12 fact sheet; methylcobalamin shown superior in neurological studies (PMID: 15208835).',
  omega:        'Supported by AHA guidelines and multiple RCTs on EPA+DHA for cardiovascular and cognitive health.',
  'fish oil':   'Supported by AHA guidelines and multiple RCTs on EPA+DHA for cardiovascular and cognitive health.',
  iron:         'Supported by WHO guidelines on iron deficiency anemia and NIH iron supplementation studies.',
  zinc:         'Supported by NIH zinc fact sheet and Cochrane review on zinc for immune function (PMID: 11869635).',
  'vitamin c':  'Supported by NIH Vitamin C fact sheet and Cochrane review on Vitamin C and immune function.',
  calcium:      'Supported by NIH calcium fact sheet and NOF guidelines on bone health.',
  coq10:        'Supported by multiple RCTs on CoQ10 for cardiovascular health and statin-induced myopathy.',
  probiotic:    'Supported by Cochrane reviews on probiotics for gut health and immune modulation.',
  ashwagandha:  'Supported by multiple RCTs on KSM-66 ashwagandha for cortisol reduction (PMID: 23439798).',
  curcumin:     'Supported by meta-analyses on curcumin for inflammation and joint health (PMID: 29480523).',
  berberine:    'Supported by RCTs showing berberine comparable to metformin for blood glucose (PMID: 20304560).',
  selenium:     'Supported by NIH selenium fact sheet and studies on thyroid function and antioxidant defense.',
  collagen:     'Supported by RCTs on collagen peptides for skin elasticity and joint health (PMID: 30681787).',
  creatine:     'Supported by ISSN position stand on creatine monohydrate for muscle strength and power.',
  melatonin:    'Supported by meta-analyses on melatonin for sleep onset latency (PMID: 17145415).',
  'vitamin k':  'Supported by NIH Vitamin K fact sheet and studies on bone and cardiovascular health.',
  folate:       'Supported by CDC and WHO guidelines on folate for neural tube defect prevention.',
  'vitamin a':  'Supported by NIH Vitamin A fact sheet and WHO guidelines on Vitamin A deficiency.',
  'vitamin e':  'Supported by NIH Vitamin E fact sheet and antioxidant research.',
  iodine:       'Supported by WHO guidelines on iodine deficiency and thyroid function.',
  potassium:    'Supported by NIH potassium fact sheet and AHA guidelines on blood pressure.',
  resveratrol:  'Supported by studies on sirtuin activation and cardiovascular protection (PMID: 17086194).',
  'alpha-lipoic': 'Supported by RCTs on ALA for insulin sensitivity and diabetic neuropathy (PMID: 11226285).',
  'tart cherry': 'Supported by RCTs on tart cherry for uric acid reduction and gout prevention (PMID: 21671418).',
};

const FOODS_MAP = {
  magnesium:    'Dark chocolate (70%+), almonds, pumpkin seeds, spinach, black beans, avocado, cashews',
  'vitamin d':  'Fatty fish (salmon, tuna, mackerel), egg yolks, fortified milk, fortified orange juice, mushrooms',
  'vitamin b12':'Beef liver, clams, sardines, tuna, salmon, fortified cereals, eggs, dairy',
  b12:          'Beef liver, clams, sardines, tuna, salmon, fortified cereals, eggs, dairy',
  omega:        'Fatty fish (salmon, tuna, sardines, mackerel), walnuts, chia seeds, flaxseeds, hemp seeds',
  'fish oil':   'Fatty fish (salmon, tuna, sardines, mackerel), walnuts, chia seeds, flaxseeds',
  iron:         'Red meat (beef, lamb, bison), spinach, beans, lentils, dark chocolate, tofu, pumpkin seeds',
  zinc:         'Oysters, beef, pumpkin seeds, hemp seeds, lentils, chickpeas, cashews',
  'vitamin c':  'Bell peppers, kiwi, strawberries, oranges, broccoli, Brussels sprouts, papaya',
  calcium:      'Dairy (Greek yogurt, cheddar cheese, whole milk), sardines, kale, broccoli, fortified plant milk',
  coq10:        'Beef heart, sardines, mackerel, pork, chicken, broccoli, cauliflower, spinach',
  probiotic:    'Fermented foods (kefir, kimchi, sauerkraut, miso), Greek yogurt, tempeh, kombucha',
  ashwagandha:  'Ashwagandha root (supplement only — not commonly found in food)',
  curcumin:     'Turmeric, curry powder, golden milk, turmeric tea',
  berberine:    'Barberries, goldenseal, Oregon grape (supplement form most effective)',
  selenium:     'Brazil nuts, tuna, sardines, shrimp, beef, turkey, eggs, sunflower seeds',
  collagen:     'Bone broth, chicken skin, fish skin, egg whites, citrus fruits (support collagen synthesis)',
  creatine:     'Red meat (beef, pork), fish (herring, salmon, tuna), chicken',
  melatonin:    'Tart cherries, walnuts, almonds, eggs, milk, fatty fish, rice, oats',
  'vitamin k':  'Leafy greens (kale, spinach, Swiss chard), broccoli, Brussels sprouts, fermented foods',
  folate:       'Leafy greens (spinach, kale), lentils, chickpeas, asparagus, avocado, fortified cereals',
  iodine:       'Seaweed, cod, tuna, shrimp, dairy, eggs, iodized salt',
  potassium:    'Bananas, sweet potatoes, spinach, avocado, beans, salmon, yogurt',
};

const SIDE_EFFECTS_MAP = {
  magnesium:    'Loose stools at high doses (>400mg). Glycinate form minimizes this. Upper limit: 350mg supplemental.',
  'vitamin d':  'Toxicity possible above 4000 IU/day long-term. Symptoms: nausea, weakness, kidney issues. Safe upper limit: 4000 IU/day.',
  'vitamin b12':'Generally very safe. Rare: acne-like rash at very high doses. No established upper limit.',
  b12:          'Generally very safe. Rare: acne-like rash at very high doses. No established upper limit.',
  omega:        'Fishy aftertaste, mild GI upset. High doses (>3g) may thin blood. Upper limit: 3g/day without medical supervision.',
  'fish oil':   'Fishy aftertaste, mild GI upset. High doses (>3g) may thin blood. Upper limit: 3g/day without medical supervision.',
  iron:         'Nausea, constipation, dark stools. Take with food to reduce GI upset. Upper limit: 45mg/day.',
  zinc:         'Nausea at high doses. Long-term high doses deplete copper. Upper limit: 40mg/day.',
  'vitamin c':  'GI upset, diarrhea at doses >2g. Upper limit: 2000mg/day.',
  calcium:      'Constipation, kidney stones at very high doses. Upper limit: 2500mg/day total.',
  coq10:        'Mild GI upset, insomnia if taken late. Generally well tolerated. No established upper limit.',
  probiotic:    'Mild bloating or gas initially (usually resolves in 1–2 weeks). Rare: infection risk in immunocompromised.',
  ashwagandha:  'Mild GI upset, drowsiness. Avoid in pregnancy. Rare: liver injury at very high doses. Cycle use recommended.',
  curcumin:     'GI upset at high doses. May thin blood. Avoid before surgery. Upper limit: 8g/day curcumin.',
  berberine:    'GI upset, cramping, diarrhea especially at start. Lowers blood sugar — monitor if diabetic.',
  selenium:     'Toxicity (selenosis) above 400mcg/day: hair loss, nail brittleness, GI issues. Upper limit: 400mcg/day.',
  collagen:     'Generally well tolerated. Rare: mild GI discomfort, allergic reaction in those sensitive to fish/eggs.',
  creatine:     'Water retention (intracellular), mild GI upset if taken without water. Safe at 3–5g/day long-term.',
  melatonin:    'Drowsiness, headache, dizziness. Do not drive after taking. Start with lowest effective dose (0.5mg).',
  'vitamin k':  'Interferes with warfarin (blood thinners) — consult doctor. Generally safe at food levels.',
  folate:       'Generally very safe. High doses may mask B12 deficiency. Upper limit: 1000mcg synthetic folic acid/day.',
};

function inferClientEvidence(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  for (const [key, val] of Object.entries(EVIDENCE_MAP)) {
    if (n.includes(key)) return val;
  }
  return 'Supported by peer-reviewed clinical nutrition research and NIH dietary supplement guidelines.';
}

function inferClientFoods(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  for (const [key, val] of Object.entries(FOODS_MAP)) {
    if (n.includes(key)) return val;
  }
  return null;
}

function inferClientSideEffects(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  for (const [key, val] of Object.entries(SIDE_EFFECTS_MAP)) {
    if (n.includes(key)) return val;
  }
  return 'Generally well tolerated at recommended doses. Consult a healthcare provider if you experience adverse effects.';
}

function enrichAiResults(aiResults) {
  if (!aiResults) return aiResults;
  return {
    ...aiResults,
    recommendations: (aiResults.recommendations || []).map(rec => ({
      ...rec,
      evidence:    rec.evidence    || inferClientEvidence(rec.name),
      foods:       rec.foods       || inferClientFoods(rec.name),
      sideEffects: rec.sideEffects || inferClientSideEffects(rec.name),
    })),
  };
}


function ConfirmModal({ title, body, confirmLabel = 'Yes, delete', cancelLabel = 'Keep it', onConfirm, onCancel, loading }) {
  // Escape must always be able to back out of a destructive prompt, and the
  // dialog has to announce itself to screen readers as a modal.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-box" role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title" onClick={e => e.stopPropagation()}>
        <div className="modal-icon" aria-hidden="true">🗑️</div>
        <h3 className="modal-title" id="confirm-modal-title">{title}</h3>
        <p className="modal-body">{body}</p>
        <div className="modal-actions">
          <button type="button" className="modal-btn-cancel" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </button>
          <button type="button" className="modal-btn-confirm" onClick={onConfirm} disabled={loading}>
            {loading ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function HistoryPage() {
  const navigate = useNavigate();
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [serverTime, setServerTime] = useState(new Date());
  const [deleting, setDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState({});
  const [toast, setToast] = useState('');
  const [showAllSupplements, setShowAllSupplements] = useState({});
  const [upgradeInfo, setUpgradeInfo] = useState(null);
  const [historyMeta, setHistoryMeta] = useState({ planLimit: null, pagination: null, currentPlan: null });
  // Local browse controls: a free-text needle plus a status lens. Both are
  // pure client-side views over the already-loaded page, so switching either
  // is instant and never costs a request.
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // all | active | expired
  // Pagination: the server serves tier-capped pages (FREE 5 / DELUXE 10 /
  // PREMIUM+ 20) and gates page 2+ behind the `historyFull` entitlement —
  // so the "5-Year Record History" feature IS paging deeper, and without
  // these controls it could never be exercised at all.
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  // The limit the SERVER actually used for the page we last loaded. Every
  // following page must request the same value: the server computes
  // skip = (page - 1) * limit, so changing the requested size between pages
  // would silently skip or repeat records.
  const [pageLimit, setPageLimit] = useState(null);
  // Reactive plan: gates re-render the instant the subscription changes.
  // History list re-loads so tier-capped page sizes update without a refresh.
  const livePlan = useSubscription();

  // `serverTime` is the clock every expiry comparison must use. The wrappers
  // below are useCallback'd so their identity only changes when the clock
  // does — otherwise the useMemo filters would rebuild on every render.
  const now = serverTime;
  const expiredOf = useCallback((item) => isExpired(item, now), [now]);
  const expirationOf = getExpirationDate;
  const leftOf = useCallback((item) => daysLeft(item, now), [now]);
  const agoOf = useCallback((dateStr) => relativeTime(dateStr, now), [now]);

  const toggleShowAllSupplements = (assessmentId) => {
    setShowAllSupplements(prev => ({ ...prev, [assessmentId]: !prev[assessmentId] }));
  };

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const loadHistory = (targetPage = 1, { append = false, limit = null } = {}) => {
    // Appending must not blank the list behind a full-page spinner.
    if (!append) setLoading(true);
    setError('');
    return getHistory(targetPage, limit || undefined)
      .then(data => {
        const normalized = data.assessments.map(item => ({
          ...item,
          aiResults: enrichAiResults(item.aiResults),
        }));
        setHistory(prev => {
          if (!append) return normalized;
          // De-dupe: overlapping pages (plan change, an item deleted elsewhere)
          // must never render the same assessment twice.
          const seen = new Set(prev.map(row => row._id));
          return [...prev, ...normalized.filter(row => !seen.has(row._id))];
        });
        setServerTime(new Date(data.serverTime));
        setHistoryMeta({ planLimit: data.planLimit || null, pagination: data.pagination || null, currentPlan: data.currentPlan || null });
        setPage(data.pagination?.page || targetPage);
        if (data.pagination?.limit) setPageLimit(data.pagination.limit);
        // NOTE: the response's `currentPlan` is a server-RESOLVED tier, not the
        // stored subscriptionActive/Plan flags. Writing it into the account
        // cache used to clobber the cached snapshot (entitlement map +
        // subscriptionEnd) and left the profile's lock grid rendering stale
        // state — the shared subscription store is the only writer now.
      })
      .catch((err) => {
        // A plan-gate 403 is the server saying this account no longer has
        // `historyFull` (downgrade/expiry). Show the paywall instead of a bare
        // toast; api.js also fires the revalidation event, so every other gate
        // in the app locks at the same moment.
        if (err?.requiresPlan) {
          setUpgradeInfo({
            requiresPlan: err.requiresPlan,
            currentPlan: err.currentPlan || livePlan.plan,
            feature: '5-Year Record History',
          });
          return;
        }
        if (append) showToast(err.message || 'Could not load more history.');
        else setError(err.message);
      })
      .finally(() => {
        if (!append) setLoading(false);
        setLoadingMore(false);
      });
  };

  // PREMIUM+ (`historyFull`) can page deeper; lower tiers get the paywall.
  const handleLoadMore = () => {
    if (loadingMore) return;
    setLoadingMore(true);
    loadHistory(page + 1, { append: true, limit: pageLimit || undefined });
  };

  useEffect(() => {
    const token = getToken();
    if (!token) { navigate('/login'); return; }

    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load from the server is an external-system sync
    loadHistory(1, { limit: historyLimitForStoredPlan() });
    const onPlan = () => loadHistory(1, { limit: historyLimitForStoredPlan() });
    window.addEventListener(SUBSCRIPTION_EVENT, onPlan);
    return () => window.removeEventListener(SUBSCRIPTION_EVENT, onPlan);
  }, [navigate]);

  // A stale paywall modal clears itself the instant the plan is upgraded
  // (SSE push, admin change, expiry) — no refresh or reopen needed.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing a stale paywall on plan change is an external-system sync
    if (upgradeInfo && livePlan.canAccess('pdfExport')) setUpgradeInfo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livePlan.active, livePlan.plan, livePlan.rank, upgradeInfo]);

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteAssessment(deleteTarget._id);
      setHistory(prev => prev.filter(h => h._id !== deleteTarget._id));
      // Keep "Showing X of Y" honest after a removal.
      setHistoryMeta(prev => (prev.pagination && Number.isFinite(prev.pagination.total)
        ? { ...prev, pagination: { ...prev.pagination, total: Math.max(0, prev.pagination.total - 1) } }
        : prev));
      setExpanded(null);
      showToast('Assessment deleted successfully.');
      setDeleteTarget(null);
    } catch {
      showToast('Failed to delete. Please try again.');
    } finally {
      setDeleting(false);
    }
  };

  const handleKeepAssessment = () => {
    setDeleteTarget(null);
  };

  const getTab = (id) => activeTab[id] || 'assessment';
  const setTab = (id, tab) => setActiveTab(prev => ({ ...prev, [id]: tab }));

  // ── Derived view model ───────────────────────────────────────────────
  // The "active" record is the newest one still in force. The server defines
  // it the same way (findActiveAssessment filters expired rows out before
  // sorting), so the badge here can never disagree with the Dashboard.
  const activeId = useMemo(() => {
    const row = history.find(item => !expiredOf(item));
    return row ? row._id : null;
  }, [history, expiredOf]);

  const counts = useMemo(() => {
    let expired = 0; let priority = 0; let withAi = 0;
    for (const item of history) {
      if (expiredOf(item)) expired += 1;
      if (item.priority === 'Priority') priority += 1;
      if (item.aiResults) withAi += 1;
    }
    return { expired, priority, withAi, total: history.length };
  }, [history, expiredOf]);

  // The record that will retire soonest — surfaced so a user can act before
  // data silently drops out of their active views.
  const soonestExpiry = useMemo(() => {
    let soonest = null;
    for (const item of history) {
      const left = leftOf(item);
      if (left === null || left < 0) continue;
      if (!soonest || left < soonest.left) soonest = { item, left };
    }
    return soonest;
  }, [history, leftOf]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return history.filter(item => {
      if (statusFilter === 'active' && item._id !== activeId) return false;
      if (statusFilter === 'expired' && !expiredOf(item)) return false;
      if (!needle) return true;
      // Search the whole record, not just the headline, so a goal, symptom or
      // diet typed into the box still finds the assessment it came from.
      return [
        fmt(item.createdAt),
        cardTitle(item),
        item.dietType,
        item.age,
        ACTIVITY_LABELS[item.activityLevel] || item.activityLevel,
        ...(item.symptoms || []),
        ...(item.healthGoals || []),
        ...(item.medicalConditions || []),
      ].some(v => v && String(v).toLowerCase().includes(needle));
    });
  }, [history, query, statusFilter, activeId, expiredOf]);

  const isFiltering = query.trim().length > 0 || statusFilter !== 'all';
  const clearFilters = () => { setQuery(''); setStatusFilter('all'); };

  return (
    <div className="history-wrapper">
      <Navbar />

      {/* Delete Modal */}
      {deleteTarget && (
        <ConfirmModal
          title="Review an older assessment"
          body="This assessment is more than five years old. Would you like to delete it from your history?"
          confirmLabel="Delete assessment"
          cancelLabel="Keep assessment"
          onConfirm={handleDeleteConfirm}
          onCancel={handleKeepAssessment}
          loading={deleting}
        />
      )}

      {/* Toast */}
      {toast && <div className="history-toast" role="status" aria-live="polite">{toast}</div>}

      <div className="history-container">
        <div className="history-header">
          <div className="history-header-text">
            <span className="history-eyebrow">Your health timeline</span>
            <h2>Assessment History</h2>
            <p className="history-subtitle">
              Every assessment you have completed, kept for 5 years. Open one to review your
              answers, results and full plan.
            </p>
          </div>
          <div className="history-header-actions">
            <button className="btn-primary btn-primary-lg" onClick={() => navigate('/assessment')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              New Assessment
            </button>
          </div>
        </div>

        {activeId && (
          <div className="active-info-banner" role="status">
            <span className="active-info-icon" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="16" x2="12" y2="12"/>
                <line x1="12" y1="8" x2="12.01" y2="8"/>
              </svg>
            </span>
            <span className="active-info-text">
              <strong>Your latest assessment is active.</strong> It powers your Dashboard,
              Track Intake and Insights. Complete a new assessment to update it.
            </span>
            <button className="active-info-action" onClick={() => navigate('/assessment')}>
              Start new
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </button>
          </div>
        )}

        {/* Summary tiles — orientation before the list, so the shape of the
            record is legible without opening anything. */}
        {history.length > 0 && (
          <div className="history-stats">
            <div className="history-stat history-stat-total">
              <span className="history-stat-icon" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                </svg>
              </span>
              <span className="history-stat-body">
                <span className="history-stat-value">{counts.total}</span>
                <span className="history-stat-label">Assessment{counts.total === 1 ? '' : 's'}</span>
              </span>
            </div>
            <div className="history-stat history-stat-active">
              <span className="history-stat-icon" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                  <polyline points="22 4 12 14.01 9 11.01"/>
                </svg>
              </span>
              <span className="history-stat-body">
                <span className="history-stat-value">{activeId ? 'Live' : 'None'}</span>
                <span className="history-stat-label">Active record</span>
              </span>
            </div>
            <div className="history-stat history-stat-ai">
              <span className="history-stat-icon" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>
                  <circle cx="12" cy="12" r="3.2"/>
                </svg>
              </span>
              <span className="history-stat-body">
                <span className="history-stat-value">{counts.withAi}</span>
                <span className="history-stat-label">With AI analysis</span>
              </span>
            </div>
            {counts.priority > 0 && (
              <div className="history-stat history-stat-priority">
                <span className="history-stat-icon" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
                    <line x1="4" y1="22" x2="20" y2="22"/>
                  </svg>
                </span>
                <span className="history-stat-body">
                  <span className="history-stat-value">{counts.priority}</span>
                  <span className="history-stat-label">Flagged priority</span>
                </span>
              </div>
            )}
            {soonestExpiry && soonestExpiry.left <= 180 && (
              <div className="history-stat history-stat-expiry">
                <span className="history-stat-icon" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <polyline points="12 6 12 12 16 14"/>
                  </svg>
                </span>
                <span className="history-stat-body">
                  <span className="history-stat-value">
                    {soonestExpiry.left}d
                  </span>
                  <span className="history-stat-label">Until next expiry</span>
                </span>
              </div>
            )}
          </div>
        )}

        {loading && (
          <div className="history-loading-simple">
            <div className="loading-spinner-simple"></div>
          </div>
        )}

        {error && (
          <div className="history-error-box" role="alert">
            <div className="history-error-icon">⚠️</div>
            <p className="history-error-title">Could not load your history</p>
            <p className="history-error-msg">{error}</p>
            <button className="btn-primary" onClick={() => window.location.reload()}>Try Again</button>
          </div>
        )}
        {!loading && !error && history.length === 0 && (
          <div className="history-empty">
            <div className="history-empty-icon" aria-hidden="true">
              <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
                <polyline points="10 9 9 9 8 9"/>
              </svg>
            </div>
            <h3 className="history-empty-title">No assessments yet</h3>
            <p className="history-empty-body">
              You haven't completed any assessments yet. Complete your first health assessment
              to start building your assessment history.
            </p>
            <button className="btn-primary btn-primary-lg" onClick={() => navigate('/assessment')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Start your first assessment
            </button>
          </div>
        )}

        {/* Search + status lens. Both are pure client-side views over the
            loaded page, so they are instant and cost no request. */}
        {history.length > 1 && (
          <div className="history-toolbar">
            <div className="history-search">
              <svg className="history-search-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7"/>
                <line x1="20" y1="20" x2="16.65" y2="16.65"/>
              </svg>
              <input
                type="search"
                className="history-search-input"
                placeholder="Search symptoms, goals, diet…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search your assessments"
              />
              {query && (
                <button
                  className="history-search-clear"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                  type="button"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              )}
            </div>
            <div className="history-filters" role="group" aria-label="Filter assessments by status">
              {[
                { key: 'all', label: 'All' },
                { key: 'active', label: 'Active' },
                { key: 'expired', label: 'Expired' },
              ].map(opt => (
                <button
                  key={opt.key}
                  type="button"
                  className={`history-filter ${statusFilter === opt.key ? 'active' : ''}`}
                  aria-pressed={statusFilter === opt.key}
                  onClick={() => setStatusFilter(opt.key)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {isFiltering && filtered.length === 0 && history.length > 0 && (
          <div className="history-no-results">
            <div className="history-no-results-icon" aria-hidden="true">🔍</div>
            <h3 className="history-no-results-title">No matching assessments</h3>
            <p className="history-no-results-body">
              {query.trim()
                ? `Nothing matches “${query.trim()}”. Try a different symptom, goal or diet.`
                : 'No assessments in this state yet.'}
            </p>
            <button type="button" className="history-no-results-reset" onClick={clearFilters}>
              Clear filters
            </button>
          </div>
        )}

        <div className="history-list">
          {filtered.map(item => {
            const isActive = item._id === activeId;
            const expired = expiredOf(item);
            const days = leftOf(item);
            return (
            <div key={item._id} className={`history-card${isActive ? ' history-card-active' : ''}${expanded === item._id ? ' history-card-open' : ''}`}>
              {/* Card Header */}
              <div className="history-card-header" onClick={() => setExpanded(expanded === item._id ? null : item._id)}>
                <div className="history-card-header-left">
                  <div className="date-with-badge">
                    {isActive && (
                      <span
                        className="active-badge"
                        title="This is your active assessment. Your Dashboard, Track Intake, and Insights use this data."
                      >
                        Active
                      </span>
                    )}
                    {expired && (
                      <span
                        className="expired-badge"
                        title="This assessment has expired. Its record is kept below for reference."
                      >
                        Expired
                      </span>
                    )}
                    <span className="history-date">{fmt(item.createdAt)}</span>
                    <span className="history-ago">{agoOf(item.createdAt)}</span>
                  </div>
                  <div className="history-card-title">{cardTitle(item)}</div>
                  <div className="history-tags">
                    {item.priority === 'Priority' && (
                      <span className="tag tag-priority" title={(item.flagReasons || []).join('; ') || 'Flagged for priority review'}>
                        ⚑ Priority
                      </span>
                    )}
                    {item.age && <span className="tag tag-blue">Age {item.age}</span>}
                    {item.dietType && <span className="tag">{item.dietType}</span>}
                    {item.activityLevel && <span className="tag">{ACTIVITY_LABELS[item.activityLevel] || item.activityLevel}</span>}
                    {item.symptoms?.length > 0 && !item.symptoms.includes('None') && (
                      <span className="tag tag-red">{item.symptoms.length} symptom{item.symptoms.length > 1 ? 's' : ''}</span>
                    )}
                    {item.aiResults && <span className="tag tag-green">✓ AI Analysis</span>}
                    {item.priority === 'Priority' ? (
                      <span className="tag tag-flag" title="Flagged assessments never expire while under review">
                        No expiry — resolves on completion
                      </span>
                    ) : expired ? (
                      <span className="tag tag-expired">Expired {fmt(expirationOf(item))}</span>
                    ) : days !== null && days <= 180 ? (
                      // Amber once the retirement date is close enough to plan around.
                      <span className="tag tag-warn" title={`Expires ${fmt(expirationOf(item))}`}>
                        Expires in {days} day{days === 1 ? '' : 's'}
                      </span>
                    ) : (
                      <span className="tag tag-gray">Expires {fmt(expirationOf(item))}</span>
                    )}
                  </div>
                </div>
                <div className="history-card-header-right">
                    <button
                    className="btn-view-answers"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate('/assessment', { state: { assessment: item, readOnly: true } });
                    }}
                    title="View Assessment"
                    aria-label="View assessment answers"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <circle cx="12" cy="9" r="3" />
                      <path d="M6 19c0-3.314 2.686-6 6-6s6 2.686 6 6" />
                    </svg>
                  </button>
                  {item.aiResults && (
                    <button
                      className="btn-view-results"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate('/results', { state: { recommendations: item.aiResults, assessment: item } });
                      }}
                      title="View Results"
                      aria-label="View results and recommendations"
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <path d="M9 13l5-5 3 3-5 5H9v-3z" />
                      </svg>
                    </button>
                  )}
                  {item.aiResults && (
                    <button
                      className="btn-download-pdf"
                      onClick={async (e) => {
                        e.stopPropagation();
                        // Local gate first (instant UI), then the backend
                        // re-verifies before the browser renders the report.
                        if (!livePlan.canAccess('pdfExport')) {
                          setUpgradeInfo({ requiresPlan: 'monthly', currentPlan: livePlan.plan, feature: 'PDF Report Export' });
                          return;
                        }
                        try {
                          await checkFeature('pdfExport');
                          // The call was never awaited, so a failed export
                          // rejected as an unhandled promise and the button
                          // looked like it did nothing at all.
                          const generated = await exportResultsToPDF(item.aiResults, item);
                          if (!generated) throw new Error('The report could not be generated. Please try again.');
                        } catch (err) {
                          if (err?.requiresPlan) {
                            setUpgradeInfo({ requiresPlan: err.requiresPlan, currentPlan: err.currentPlan || livePlan.plan, feature: 'PDF Report Export' });
                          } else {
                            console.error('PDF export blocked:', err);
                            showToast('Could not generate the PDF. Please try again.');
                          }
                        }
                      }}
                      title="Download PDF report"
                      aria-label="Download PDF report"
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                      </svg>
                    </button>
                  )}
                  {expired && (
                    <button
                      className="btn-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(item);
                      }}
                      title="Delete expired assessment record"
                      aria-label="Delete expired assessment record"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                      </svg>
                    </button>
                  )}

                  <span
                    className="history-toggle"
                    role="button"
                    tabIndex={0}
                    aria-label={expanded === item._id ? 'Collapse details' : 'Expand details'}
                    aria-expanded={expanded === item._id}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        setExpanded(expanded === item._id ? null : item._id);
                      }
                    }}
                  >
                    <svg
                      className="history-toggle-caret"
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </span>
                </div>
              </div>

              {/* Expanded Content */}
              {expanded === item._id && (
                <div className="history-card-body">
                  <div className="history-tabs">
                    <button className={`history-tab ${getTab(item._id) === 'assessment' ? 'active' : ''}`}
                      onClick={() => setTab(item._id, 'assessment')}>📋 Assessment</button>
                    {item.aiResults && (
                      <>
                        <button className={`history-tab ${getTab(item._id) === 'supplements' ? 'active' : ''}`}
                          onClick={() => setTab(item._id, 'supplements')}>💊 Supplements</button>
                        <button className={`history-tab ${getTab(item._id) === 'schedule' ? 'active' : ''}`}
                          onClick={() => setTab(item._id, 'schedule')}>🗓️ Schedule & Recovery</button>
                        <button className={`history-tab ${getTab(item._id) === 'meals' ? 'active' : ''}`}
                          onClick={() => setTab(item._id, 'meals')}>🍽️ Meals</button>
                        <button className={`history-tab ${getTab(item._id) === 'lifestyle' ? 'active' : ''}`}
                          onClick={() => setTab(item._id, 'lifestyle')}>🌿 Lifestyle</button>
                        {(item.aiResults.warnings?.length > 0 || item.aiResults.avoidList?.length > 0 || item.aiResults.seekingSupport?.include) && (
                          <button className={`history-tab history-tab-warn ${getTab(item._id) === 'warnings' ? 'active' : ''}`}
                            onClick={() => setTab(item._id, 'warnings')}>⚠️ Warnings</button>
                        )}
                      </>
                    )}
                  </div>

                  {getTab(item._id) === 'assessment' && (
                    <div className="tab-content">
                      <div className="history-grid">
                        {item.age && <div className="history-item"><span>Age</span><strong>{item.age}</strong></div>}
                        {item.gender && <div className="history-item"><span>Gender</span><strong>{item.gender}</strong></div>}
                        {item.weight && <div className="history-item"><span>Weight</span><strong>{item.weight} kg</strong></div>}
                        {item.height && <div className="history-item"><span>Height</span><strong>{item.height} cm</strong></div>}
                        {item.weight && item.height && (() => {
                          const bmi = (item.weight / ((item.height / 100) ** 2)).toFixed(1);
                          const cat = bmi < 18.5 ? 'Underweight' : bmi < 25 ? 'Normal weight' : bmi < 30 ? 'Overweight' : 'Obese';
                          return <div className="history-item"><span>BMI</span><strong>{bmi} <span className="history-item-note">({cat})</span></strong></div>;
                        })()}
                        {item.activityLevel && <div className="history-item"><span>Physical Activity Level</span><strong>{ACTIVITY_LABELS[item.activityLevel] || item.activityLevel}</strong></div>}
                        {item.dietType && <div className="history-item"><span>Diet</span><strong>{item.dietType}</strong></div>}
                      </div>
                      {item.healthGoals?.length > 0 && (
                        <div className="history-section">
                          <p className="history-section-label">Health Goals</p>
                          <div className="tag-list">{item.healthGoals.map(g => <span key={g} className="tag">{g}</span>)}</div>
                        </div>
                      )}
                      {item.symptoms?.length > 0 && !item.symptoms.includes('None') && (
                        <div className="history-section">
                          <p className="history-section-label">Symptoms</p>
                          <div className="tag-list">{item.symptoms.map(s => <span key={s} className="tag tag-red">{s}</span>)}</div>
                        </div>
                      )}
                      {item.medicalConditions?.length > 0 && !item.medicalConditions.includes('None') && (
                        <div className="history-section">
                          <p className="history-section-label">Medical Conditions</p>
                          <div className="tag-list">{item.medicalConditions.map(c => <span key={c} className="tag tag-orange">{c}</span>)}</div>
                        </div>
                      )}
                      {item.aiResults?.summary && (
                        <div className="history-section">
                          <p className="history-section-label">AI Summary</p>
                          <p className="history-feeling">{item.aiResults.summary}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {getTab(item._id) === 'supplements' && item.aiResults && (
                    <div className="tab-content">
                      {(() => {
                        const PRIORITY_ORDER = { High: 0, Medium: 1, Low: 2 };
                        const recs = [...(item.aiResults.recommendations || [])].sort((a, b) => {
                          const pa = PRIORITY_ORDER[a.priority] ?? 3;
                          const pb = PRIORITY_ORDER[b.priority] ?? 3;
                          if (pa !== pb) return pa - pb;
                          return (b.confidenceScore || 0) - (a.confidenceScore || 0);
                        });
                        const showAll = !!showAllSupplements[item._id];
                        const visible = showAll ? recs : recs.slice(0, 3);
                        return (
                          <>
                            {visible.map((rec, ri) => (
                              <div key={ri} className="history-rec-card">
                                <div className="history-rec-top">
                                  <strong>{rec.name}</strong>
                                  <span className="rec-priority-small"
                                    style={{ background: priorityColor[rec.priority] + '20', color: priorityColor[rec.priority] }}>
                                    {rec.priority} Priority
                                  </span>
                                </div>
                                <p className="history-rec-reason">{fixChars(rec.reason)}</p>
                                <div className="history-rec-meta">
                                  <span><b>Dosage:</b> {rec.dosage}</span>
                                  <span><b>Timing:</b> {rec.timing}</span>
                                </div>
                                {rec.interactions && rec.interactions !== 'None identified' && (
                                  <p className="history-rec-interaction">⚠ {rec.interactions}</p>
                                )}
                                {rec.evidence && !isPlaceholderEvidence(rec.evidence) && (
                                  <p className="history-rec-evidence history-rec-evidence-blue">📚 <strong>Evidence:</strong> {fixChars(rec.evidence)}</p>
                                )}
                                {rec.foods && (
                                  <p className="history-rec-evidence history-rec-foods">🥗 <strong>Food Sources:</strong> {expandFoodText(rec.foods)}</p>
                                )}
                                {rec.sideEffects && (
                                  <p className="history-rec-evidence history-rec-sideeffects">⚠ <strong>Side Effects &amp; Safe Limits:</strong> {fixChars(rec.sideEffects)}</p>
                                )}
                              </div>
                            ))}
                            {recs.length > 3 && (
                              <button
                                className="supp-toggle-btn"
                                onClick={() => toggleShowAllSupplements(item._id)}
                              >
                                {showAll
                                  ? 'Show less ▲'
                                  : `Show more ▼  (${recs.length - 3} more supplement${recs.length - 3 > 1 ? 's' : ''})`}
                              </button>
                            )}
                          </>
                        );
                      })()}
                      {item.aiResults.avoidList?.length > 0 && (
                        <div className="history-avoid">
                          <p className="history-section-label">🚫 Avoid</p>
                          <ul>{item.aiResults.avoidList.map((a, ai) => <li key={ai}>{a}</li>)}</ul>
                        </div>
                      )}
                      {item.aiResults.warnings?.length > 0 && (
                        <div className="history-warnings">
                          <p className="history-section-label">⚠️ Warnings</p>
                          <ul>{item.aiResults.warnings.map((w, wi) => <li key={wi}>{w}</li>)}</ul>
                        </div>
                      )}
                    </div>
                  )}

                  {getTab(item._id) === 'schedule' && item.aiResults && (
                    <div className="tab-content">
                      {/* Daily Schedule */}
                      {item.aiResults.dailySchedule?.length > 0 ? (() => {
                        const dosageMap = {};
                        (item.aiResults.recommendations || []).forEach(rec => {
                          if (rec.name && rec.dosage) dosageMap[rec.name.toLowerCase()] = rec.dosage;
                        });
                        const getDosage = (pillName) => {
                          const pill = pillName.toLowerCase().trim();
                          if (dosageMap[pill]) return dosageMap[pill];
                          for (const [recName, dosage] of Object.entries(dosageMap)) {
                            if (pill === recName) return dosage;
                            if (recName.length > 4 && pill.includes(recName)) return dosage;
                            if (pill.length > 4 && recName.includes(pill)) return dosage;
                          }
                          const genericWords = new Set(['vitamin','mineral','acid','complex','supplement','extract','oxide','citrate']);
                          const pillSpecific = pill.split(/\s+/).filter(w => w.length > 1 && !genericWords.has(w));
                          if (pillSpecific.length > 0) {
                            for (const [recName, dosage] of Object.entries(dosageMap)) {
                              const recSpecific = recName.split(/\s+/).filter(w => w.length > 1 && !genericWords.has(w));
                              if (recSpecific.length > 0 && pillSpecific.every(w => recSpecific.includes(w)) && recSpecific.every(w => pillSpecific.includes(w))) {
                                return dosage;
                              }
                            }
                          }
                          return null;
                        };
                        return (
                          <div className="history-schedule">
                            {item.aiResults.dailySchedule.map((slot, si) => (
                              <div key={si} className="history-schedule-slot">
                                <div className="history-schedule-time">{fixChars(slot.time.replace(/With Lunch/gi, 'Afternoon'))}</div>
                                <div className="history-schedule-pills">
                                  {slot.supplements.map((s, sj) => {
                                    // Strip any dosage text the AI may have included after ' - '
                                    const pillName = s.split(' - ')[0].trim();
                                    const dosage = getDosage(pillName);
                                    return (
                                      <span key={sj} className="history-schedule-pill">
                                        {fixChars(pillName)}{dosage ? <span className="history-schedule-pill-dosage"> - {fixChars(dosage)}</span> : ''}
                                      </span>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        );
                      })() : (
                        <p className="history-muted">No daily schedule recorded for this assessment.</p>
                      )}

                      {/* Recovery Plan */}
                      {item.aiResults.actionPlan?.length > 0 && (
                        <div className={`history-recovery-plan${item.aiResults.dailySchedule?.length > 0 ? ' history-recovery-plan-spaced' : ''}`}>
                          {item.aiResults.actionPlan.map((phase, si) => {
                            if (typeof phase === 'string') {
                              return (
                                <div key={si} className="history-recovery-phase">
                                  <div className="history-recovery-header">
                                    <span className="history-recovery-num">{si + 1}</span>
                                    <p className="history-recovery-title">{fixChars(phase)}</p>
                                  </div>
                                </div>
                              );
                            }
                            const steps = phase.steps?.length > 0 ? phase.steps : [
                              ...(phase.supplements || []),
                              ...(phase.habits || []),
                              ...(phase.activity || []),
                            ];
                            const expected = phase.expectedChanges || [];
                            return (
                              <div key={si} className="history-recovery-phase">
                                <div className="history-recovery-header">
                                  <span className="history-recovery-num">{si + 1}</span>
                                  <div>
                                    <p className="history-recovery-title">{fixChars(phase.phase || phase.week)}</p>
                                    {phase.focus && <p className="history-recovery-focus">{fixChars(phase.focus)}</p>}
                                  </div>
                                </div>
                                {steps.length > 0 && (
                                  <ul className="history-recovery-steps">
                                    {steps.map((step, ti) => <li key={ti}>{fixChars(step)}</li>)}
                                  </ul>
                                )}
                                {expected.length > 0 && (
                                  <div className="history-recovery-expected">
                                    <span className="history-recovery-expected-label">✦ Expected Changes</span>
                                    <ul>
                                      {expected.map((e, ei) => <li key={ei}>{fixChars(e)}</li>)}
                                    </ul>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {getTab(item._id) === 'lifestyle' && item.aiResults && (
                    <div className="tab-content">
                      {item.aiResults.lifestyleAdvice?.length > 0 ? (
                        item.aiResults.lifestyleAdvice.map((la, li) => (
                          <div key={li} className="history-lifestyle-card">
                            <span className="lifestyle-category-badge">{la.category}</span>
                            <p>{la.advice}</p>
                          </div>
                        ))
                      ) : (
                        <p className="history-muted">No lifestyle advice recorded for this assessment.</p>
                      )}
                    </div>
                  )}

                  {getTab(item._id) === 'meals' && item.aiResults && (
                    <div className="tab-content">
                      {item.aiResults.mealRecommendations?.length > 0 ? (
                        item.aiResults.mealRecommendations.map((meal, mi) => (
                          <div key={mi} className="history-lifestyle-card history-lifestyle-card-meal">
                            <span className="lifestyle-category-badge">{meal.meal}</span>
                            <p>{meal.suggestion}</p>
                          </div>
                        ))
                      ) : (
                        <p className="history-muted">No meal recommendations recorded for this assessment.</p>
                      )}
                    </div>
                  )}



                  {getTab(item._id) === 'warnings' && item.aiResults && (
                    <div className="tab-content">
                      {item.aiResults.warnings?.length > 0 && (
                        <div className="history-warnings-block">
                          <div className="history-warnings-title">
                            <span className="warn-icon">⚠️</span>
                            Important Warnings
                          </div>
                          <ul className="history-warnings-list">
                            {item.aiResults.warnings.map((w, wi) => (
                              <li key={wi} className="history-warning-item">{w}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {item.aiResults.avoidList?.length > 0 && (
                        <div className="history-avoid-block">
                          <div className="history-avoid-title">
                            <span className="avoid-icon">🚫</span>
                            Supplements to Avoid
                          </div>
                          <ul className="history-avoid-list">
                            {item.aiResults.avoidList.map((a, ai) => (
                              <li key={ai} className="history-avoid-item">{a}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {!item.aiResults.warnings?.length && !item.aiResults.avoidList?.length && (
                        <p className="history-muted">No warnings or supplements to avoid for this assessment.</p>
                      )}
                      {item.aiResults.seekingSupport?.include && (
                        <div className="history-seeking-support">
                          <div className="history-seeking-support-header">
                            <span>💙</span>
                            <span>{fixChars(item.aiResults.seekingSupport.title)}</span>
                          </div>
                          <p className="history-seeking-support-intro">{fixChars(item.aiResults.seekingSupport.intro)}</p>
                          <div className="history-seeking-support-resources">
                            {(item.aiResults.seekingSupport.resources || []).map((res, ri) => (
                              <a key={ri} href={safeUrl(res.url) || undefined} target="_blank" rel="noopener noreferrer" className="history-seeking-support-card">
                                <span className="history-seeking-label">{fixChars(res.label)}</span>
                                <span className="history-seeking-name">{fixChars(res.name)}</span>
                                <p className="history-seeking-desc">{fixChars(res.description)}</p>
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            );
          })}
        </div>
        {/* PREMIUM+ ("5-Year Record History"): keep paging through every record.
            This control is the feature itself — without it page 2+ of the
            server's gate was unreachable for every plan. */}
        {historyMeta.pagination?.hasMore && livePlan.canAccess('historyFull') && (
          <div className="history-load-more">
            <button
              type="button"
              className="upgrade-btn upgrade-btn-primary"
              onClick={handleLoadMore}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading…' : 'Load older assessments'}
            </button>
            <p className="history-load-more__note">
              Showing {history.length}
              {Number.isFinite(historyMeta.pagination?.total) ? ` of ${historyMeta.pagination.total}` : ''} records
              {pageLimit ? ` · ${pageLimit} per page` : ''}
            </p>
          </div>
        )}
        {historyMeta.pagination?.hasMore && !livePlan.canAccess('historyFull') && (
          <div className="plan-locked plan-locked-inline">
            <div className="plan-locked__icon">🔒</div>
            <h3 className="plan-locked__title">More history is locked</h3>
            <p className="plan-locked__body">Full 5-year history requires <strong>{PLAN_LABELS.annual}</strong>. Your plan allows {historyMeta.planLimit || 5} per page.</p>
            <p className="plan-locked__note">Upgrade on the pricing page to unlock the full history.</p>
            <div className="plan-locked__actions">
              <button type="button" className="upgrade-btn upgrade-btn-primary" onClick={() => navigate('/pricing')}>View plans</button>
            </div>
          </div>
        )}
      </div>
      {upgradeInfo && (
        <UpgradeModal
          feature={upgradeInfo.feature || 'PDF Report Exports'}
          requiredPlan={upgradeInfo.requiresPlan}
          currentPlan={upgradeInfo.currentPlan}
          onClose={() => setUpgradeInfo(null)}
          onViewPlans={() => navigate('/pricing')}
        />
      )}
    </div>
  );
}

export default HistoryPage;
