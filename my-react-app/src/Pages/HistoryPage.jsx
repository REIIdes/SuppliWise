import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import ReadOnlyAssessment from '../Components/ReadOnlyAssessment/ReadOnlyAssessment';
import { getHistory, deleteAssessment } from '../api';
import { exportResultsToPDF } from '../utils/exportPDF';
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
    // Strip remaining unsafe non-ASCII
    .replace(/[^\x00-\xFF]/g, '');
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
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-icon">🗑️</div>
        <h3 className="modal-title">{title}</h3>
        <p className="modal-body">{body}</p>
        <div className="modal-actions">
          <button className="modal-btn-cancel" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </button>
          <button className="modal-btn-confirm" onClick={onConfirm} disabled={loading}>
            {loading ? 'Deleting...' : confirmLabel}
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
  const [answersTarget, setAnswersTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState({});
  const [toast, setToast] = useState('');
  const [showAllSupplements, setShowAllSupplements] = useState({});

  const getExpirationDate = (item) => {
    if (item.expiresAt) return new Date(item.expiresAt);
    const createdAt = new Date(item.createdAt);
    if (Number.isNaN(createdAt.getTime())) return null;
    // Add exactly 5 years to the created date (maintaining same time)
    const expirationDate = new Date(createdAt);
    expirationDate.setFullYear(expirationDate.getFullYear() + 5);
    return expirationDate;
  };

  const toggleShowAllSupplements = (assessmentId) => {
    setShowAllSupplements(prev => ({ ...prev, [assessmentId]: !prev[assessmentId] }));
  };

  const isOlderThanFiveYears = (dateStr, referenceTime = new Date()) => {
    if (!dateStr) return false;
    const createdAt = new Date(dateStr);
    const reference = new Date(referenceTime);
    if (Number.isNaN(createdAt.getTime()) || Number.isNaN(reference.getTime())) return false;
    // Check if 5 years have passed by comparing years and dates
    const expirationDate = new Date(createdAt);
    expirationDate.setFullYear(expirationDate.getFullYear() + 5);
    return reference.getTime() >= expirationDate.getTime();
  };

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) { navigate('/login'); return; }

    getHistory()
      .then(data => {
        const normalized = data.assessments.map(item => ({
          ...item,
          aiResults: enrichAiResults(item.aiResults),
        }));
        setHistory(normalized);
        setServerTime(new Date(data.serverTime));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [navigate]);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const fmt = (dateStr) =>
    new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteAssessment(deleteTarget._id);
      setHistory(prev => prev.filter(h => h._id !== deleteTarget._id));
      setExpanded(null);
      showToast('Assessment deleted successfully.');
      setDeleteTarget(null);
    } catch (err) {
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
      {toast && <div className="history-toast">{toast}</div>}

      <div className="history-container">
        <div className="history-header">
          <h2>Assessment History</h2>
          <div className="history-header-actions">
            <button className="btn-primary" onClick={() => navigate('/assessment')}>
              + New Assessment
            </button>
          </div>
        </div>

        {history.length > 0 && (
          <div className="active-info-banner">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="16" x2="12" y2="12"/>
              <line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
            <span>Your latest assessment is currently active and is used for your Dashboard, Track Intake, and Insights. Complete a new assessment to update your active assessment.</span>
          </div>
        )}

        {loading && <p className="history-status">Loading history...</p>}
        {error && (
          <div className="history-error-box">
            <div className="history-error-icon">⚠️</div>
            <p className="history-error-title">Could not load your history</p>
            <p className="history-error-msg">{error}</p>
            <button className="btn-primary" onClick={() => window.location.reload()}>Try Again</button>
          </div>
        )}
        {!loading && !error && history.length === 0 && (
          <div className="history-empty">
            <div className="history-empty-icon">📋</div>
            <p style={{ fontWeight: 600, color: '#374151', fontSize: '16px', margin: 0 }}>No assessments yet</p>
            <p style={{ margin: 0 }}>Complete your first health assessment to get personalized supplement and lifestyle recommendations.</p>
            <button className="btn-primary" onClick={() => navigate('/assessment')}>
              Start Assessment →
            </button>
          </div>
        )}

        {answersTarget && (
          <ReadOnlyAssessment assessment={answersTarget} inline onClose={() => setAnswersTarget(null)} />
        )}

        <div className="history-list">
          {history.map((item, i) => (
            <div key={item._id} className="history-card">
              {/* Card Header */}
              <div className="history-card-header" onClick={() => setExpanded(expanded === i ? null : i)}>
                <div className="history-card-header-left">
                  <div className="date-with-badge">
                    {i === 0 && (
                      <span 
                        className="active-badge" 
                        title="This is your active assessment. Your Dashboard, Track Intake, and Insights use this data."
                      >
                        Active
                      </span>
                    )}
                    <span className="history-date">{fmt(item.createdAt)}</span>
                  </div>
                  <div className="history-card-title">
                    {item.symptoms?.length > 0 && !item.symptoms.includes('None')
                      ? item.symptoms.slice(0, 2).join(', ') + (item.symptoms.length > 2 ? ` +${item.symptoms.length - 2} more` : '')
                      : item.healthGoals?.length > 0
                        ? item.healthGoals.slice(0, 2).join(', ')
                        : 'General Wellness Assessment'}
                  </div>
                  <div className="history-tags">
                    {item.age && <span className="tag tag-blue">Age {item.age}</span>}
                    {item.dietType && <span className="tag">{item.dietType}</span>}
                    {item.activityLevel && <span className="tag">{ACTIVITY_LABELS[item.activityLevel] || item.activityLevel}</span>}
                    {item.symptoms?.length > 0 && !item.symptoms.includes('None') && (
                      <span className="tag tag-red">{item.symptoms.length} symptom{item.symptoms.length > 1 ? 's' : ''}</span>
                    )}
                    {item.aiResults && <span className="tag tag-green">✓ AI Analysis</span>}
                    {getExpirationDate(item) && (
                      <span className="tag tag-gray">Expires {fmt(getExpirationDate(item))}</span>
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
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <path d="M9 13l5-5 3 3-5 5H9v-3z" />
                      </svg>
                    </button>
                  )}
                  {item.aiResults && (
                    <button
                      className="btn-download-pdf"
                      onClick={(e) => {
                        e.stopPropagation();
                        exportResultsToPDF(item.aiResults, item);
                      }}
                      title="Download PDF report"
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                      </svg>
                    </button>
                  )}
                  {isOlderThanFiveYears(item.createdAt) && (
                    <button
                      className="btn-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(item);
                      }}
                      title="Delete assessment"
                    >
                      🗑
                    </button>
                  )}
                  
                  <span className="history-toggle">{expanded === i ? '▲' : '▼'}</span>
                </div>
              </div>

              {/* Expanded Content */}
              {expanded === i && (
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
                          return <div className="history-item"><span>BMI</span><strong>{bmi} <span style={{ fontWeight: 400, color: '#6b7280' }}>({cat})</span></strong></div>;
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
                          const pill = pillName.toLowerCase();
                          if (dosageMap[pill]) return dosageMap[pill];
                          for (const [recName, dosage] of Object.entries(dosageMap)) {
                            if (pill.includes(recName) || recName.includes(pill)) return dosage;
                            const pillWords = pill.split(/\s+/).filter(w => w.length > 3);
                            const recWords = recName.split(/\s+/).filter(w => w.length > 3);
                            if (pillWords.some(w => recWords.includes(w))) return dosage;
                          }
                          return null;
                        };
                        return (
                          <div className="history-schedule">
                            {item.aiResults.dailySchedule.map((slot, si) => (
                              <div key={si} className="history-schedule-slot">
                                <div className="history-schedule-time">{fixChars(slot.time)}</div>
                                <div className="history-schedule-pills">
                                  {slot.supplements.map((s, sj) => {
                                    const dosage = getDosage(s);
                                    return (
                                      <span key={sj} className="history-schedule-pill">
                                        {fixChars(s)}{dosage ? <span className="history-schedule-pill-dosage"> - {fixChars(dosage)}</span> : ''}
                                      </span>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        );
                      })() : (
                        <p style={{ color: '#6b7280', fontSize: '13px', padding: '8px 0' }}>No daily schedule recorded for this assessment.</p>
                      )}

                      {/* Recovery Plan */}
                      {item.aiResults.actionPlan?.length > 0 && (
                        <div className="history-recovery-plan" style={{ marginTop: item.aiResults.dailySchedule?.length > 0 ? '20px' : '0' }}>
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
                        <p style={{ color: '#6b7280', fontSize: '13px', padding: '8px 0' }}>No lifestyle advice recorded for this assessment.</p>
                      )}
                    </div>
                  )}

                  {getTab(item._id) === 'meals' && item.aiResults && (
                    <div className="tab-content">
                      {item.aiResults.mealRecommendations?.length > 0 ? (
                        item.aiResults.mealRecommendations.map((meal, mi) => (
                          <div key={mi} className="history-lifestyle-card" style={{ borderColor: '#fed7aa', background: '#fff7ed' }}>
                            <span className="lifestyle-category-badge" style={{ color: '#c2410c', background: '#ffedd5' }}>{meal.meal}</span>
                            <p>{meal.suggestion}</p>
                          </div>
                        ))
                      ) : (
                        <p style={{ color: '#6b7280', fontSize: '13px', padding: '8px 0' }}>No meal recommendations recorded for this assessment.</p>
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
                        <p style={{ color: '#6b7280', fontSize: '13px', padding: '8px 0' }}>No warnings or supplements to avoid for this assessment.</p>
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
                              <a key={ri} href={res.url} target="_blank" rel="noopener noreferrer" className="history-seeking-support-card">
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
          ))}
        </div>
      </div>
    </div>
  );
}

export default HistoryPage;
