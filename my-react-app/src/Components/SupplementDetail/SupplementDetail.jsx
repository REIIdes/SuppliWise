/**
 * The two overlays every page showing a supplement needs.
 *
 * WHY THIS IS SHARED
 *
 * A "tap for details" panel and an "ⓘ what does this evidence mean" panel are
 * not page-specific. The results page had its own copy of each; the
 * recommendations page had neither, which is why a reader who could drill into
 * a supplement from one screen could not from the other. Duplicating a modal is
 * how the two copies end up disagreeing about the cache TTL, the escape key
 * handling, or whether the page scrolls behind it.
 *
 * So they live here once. CSS is imported by this component, which means a deep
 * link that loads this file alone still gets the styling — the same rule the
 * results page follows.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getSupplementDetail, getStoredUser } from '../../api';
import { supplementIcon } from '../../utils/recommendationView';
import './SupplementDetail.css';

/* ── Detail modal ───────────────────────────────────────────────────────
   This is an AI generation, so it can take ~20s and it can fail. Both states
   have to be rendered honestly: a silent blank panel is indistinguishable from
   a broken one. */

// 30 days. The detail is general supplement knowledge, not a function of the
// assessment, so it stays valid long after the panel that opened it.
const DETAIL_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Run on unmount AND whenever the modal closes: an overlay that lets the page
    keep scrolling behind it leaves the reader scrolling a frozen page. */
function useLockBodyScroll(active) {
  useEffect(() => {
    if (!active) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [active]);
}

/** Escape closes. Every dialog the app opens owes the reader this. */
function useEscape(active, onClose) {
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, onClose]);
}

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { data, expiresAt } = JSON.parse(raw);
    if (Date.now() > expiresAt) {
      localStorage.removeItem(key);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ data, expiresAt: Date.now() + DETAIL_CACHE_TTL_MS }));
  } catch {
    // Storage full or blocked (private browsing, a webview). The detail simply
    // refetches next time; it must never break the panel that opened it.
  }
}

/** Who is reading. Never throws — storage can be unavailable entirely. */
function accountKey() {
  try {
    return getStoredUser()?.email || 'guest';
  } catch {
    return 'guest';
  }
}

/**
 * JSON with a deterministic key order.
 *
 * `JSON.stringify` emits properties in insertion order, so two objects holding
 * the same profile can produce two different strings — which would silently
 * split one reader's cache in two and cost a generation per half.
 */
function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * A short, stable fingerprint of the profile a guide is written against.
 *
 * WHY THIS IS PART OF THE CACHE KEY
 * ---------------------------------
 * The panel's own contract is that "a new assessment must not read a guide
 * written against the old one". `assessmentId` was supposed to enforce that,
 * but the recommendations screen passes the literal string `"recommendations"`
 * — a constant, not an id. So its cache key was
 * `…_recommendations_zinc picolinate` no matter how much the reader's health
 * changed in between, and a guide written against last quarter's symptoms was
 * served from localStorage without the server ever being asked. The reader sees
 * advice addressed to a profile they no longer have.
 *
 * Keying on the profile ITSELF cannot go stale that way, and it is also the
 * input the server keys on, so browser and server agree by construction: change
 * the profile, both miss; keep it, both hit, and the tap costs nothing.
 *
 * Two independent 32-bit hashes rather than one, so a collision is not
 * reachable in practice. This is a cache key and never a secret — the worst a
 * collision could do is hand the reader their own stale guide.
 */
function profileFingerprint(context) {
  const input = stableStringify(context);
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    fnv = Math.imul(fnv ^ code, 0x01000193) >>> 0;
    djb = (Math.imul(djb, 33) ^ code) >>> 0;
  }
  return `${fnv.toString(16).padStart(8, '0')}${djb.toString(16).padStart(8, '0')}`;
}

function DetailSection({ title, children }) {
  if (!children) return null;
  return (
    <section className="swdetail__section">
      <h3 className="swdetail__section-title">{title}</h3>
      {children}
    </section>
  );
}

/**
 * A personalized guide to one supplement.
 *
 * @param {object} props
 * @param {string} props.supplementName
 * @param {string} props.assessmentId cache scope — a new assessment must not
 *        read a guide written against the old one
 * @param {object} [props.context] slim patient profile, sent to the server so
 *        the guide can reference their own symptoms rather than being generic
 * @param {object} props.cache a ref shared by every panel on the page, so
 *        opening the same supplement twice in one session costs one AI call
 * @param {Function} props.onClose
 */
export function SupplementDetailModal({ supplementName, assessmentId, context, cache, onClose }) {
  // The user's identity is part of the cache key, resolved here rather than
  // passed in. Two accounts sharing a device must never read each other's
  // cached guide — a personalized guide written against someone else's
  // symptoms and medications is worse than no cache at all — and making the
  // caller remember to scope it is how that regresses.
  //
  // So is the PROFILE the guide was written against. `assessmentId` alone is not
  // enough: the recommendations screen passes a constant, so its key survived
  // every new assessment and served the previous profile's guide. The
  // fingerprint changes exactly when the guide's meaning changes. See
  // profileFingerprint.
  const profileScope = useMemo(() => profileFingerprint(context), [context]);
  const storageKey = useMemo(
    () => `swdetail_${accountKey()}_${assessmentId || 'unknown'}_${profileScope}_${String(supplementName || '').toLowerCase().trim()}`,
    [assessmentId, supplementName, profileScope],
  );

  // Resolve during init so a cached guide paints immediately. A panel that
  // flashes a spinner for content already on disk reads as broken.
  const getCached = useCallback(() => {
    if (cache?.current?.[storageKey]) return cache.current[storageKey];
    const stored = readCache(storageKey);
    // eslint-disable-next-line react-hooks/immutability -- warming the session cache on read is the point
    if (stored && cache?.current) cache.current[storageKey] = stored;
    return stored;
  }, [cache, storageKey]);

  const cached = getCached();
  const [detail, setDetail] = useState(cached);
  // A cache hit has nothing to wait for, so it must not start in the loading
  // state and then immediately leave it — that is the flash the cache exists
  // to avoid. No setState in the effect below: `detail` already distinguishes
  // the two paths, and the effect only runs on a miss.
  const [error, setError] = useState('');
  // A failure leaves `detail` null forever, so the error has to be part of the
  // "still waiting" test — otherwise a failed generation spins indefinitely.
  const loading = detail === null && !error;

  /**
   * Re-run the fetch after a failure.
   *
   * Every failure this panel can show is transient — a provider that was slow,
   * a connection that dropped — so the message asks the reader to try again and
   * the panel has to let them. A modal the reader can only escape by closing
   * and hunting for the same card again is a dead end wearing a retry message.
   *
   * `setError('')` is what turns this back into the loading state; without it
   * `loading` stays false and the retry silently does nothing visible.
   */
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setError('');
    setAttempt((n) => n + 1);
  }, []);

  const overlayRef = useRef(null);
  const titleRef = useRef(null);

  useLockBodyScroll(true);
  useEscape(true, onClose);

  useEffect(() => {
    if (detail) return undefined; // cache hit
    let cancelled = false;
    getSupplementDetail(supplementName, context)
      .then((data) => {
        if (cancelled) return;
        if (cache?.current) cache.current[storageKey] = data;
        writeCache(storageKey, data);
        setDetail(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || 'Could not load supplement details.');
      });
    return () => { cancelled = true; };
  }, [supplementName, context, cache, storageKey, detail, attempt]);

  // Move focus into the dialog so the keyboard is not left behind on the page
  // underneath, which is what makes a modal unusable without a mouse.
  useEffect(() => {
    titleRef.current?.focus?.();
  }, []);

  const onOverlayClick = (event) => {
    if (event.target === overlayRef.current) onClose();
  };

  const benefits = Array.isArray(detail?.keyBenefits) ? detail.keyBenefits : [];
  const howToTake = Array.isArray(detail?.howToTake) ? detail.howToTake : [];
  const considerations = Array.isArray(detail?.considerations) ? detail.considerations : [];

  return (
    <div className="swdetail__overlay" ref={overlayRef} onClick={onOverlayClick}>
      <div
        className="swdetail__panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Details for ${detail?.name || supplementName}`}
      >
        <header className="swdetail__header">
          <div className="swdetail__header-left">
            <span className="swdetail__icon" aria-hidden="true">{supplementIcon(supplementName)}</span>
            <h2 className="swdetail__title" tabIndex={-1} ref={titleRef}>
              {detail?.name || supplementName}
            </h2>
          </div>
          <button type="button" className="swdetail__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="swdetail__body">
          {loading && (
            <div className="swdetail__loading" role="status">
              <div className="swdetail__spinner" aria-hidden="true" />
              <p>Writing a guide for you…</p>
            </div>
          )}
          {error && (
            <div className="swdetail__error" role="alert">
              <span aria-hidden="true">⚠️</span>
              <div className="swdetail__error-body">
                <p>{error}</p>
                <button type="button" className="swdetail__retry" onClick={retry}>
                  Try again
                </button>
              </div>
            </div>
          )}

          {!loading && !error && detail && (
            <>
              {detail.overview && <p className="swdetail__overview">{detail.overview}</p>}

              <DetailSection title="Key Benefits &amp; Use Cases">
                {benefits.length > 0 && (
                  <div className="swdetail__benefits">
                    {benefits.map((benefit, i) => (
                      <div key={i} className="swdetail__benefit">
                        <span className="swdetail__benefit-title">{benefit?.title || 'Benefit'}</span>
                        {benefit?.description && <p className="swdetail__benefit-desc">{benefit.description}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </DetailSection>

              <DetailSection title="How to Take It">
                {howToTake.length > 0 && (
                  <div className="swdetail__steps">
                    {howToTake.map((step, i) => (
                      <div key={i} className="swdetail__step">
                        <span className="swdetail__step-label">{step?.title || 'Instructions'}</span>
                        {step?.description && <p className="swdetail__step-desc">{step.description}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </DetailSection>

              <DetailSection title="Considerations &amp; Safety">
                {considerations.length > 0 && (
                  <ul className="swdetail__considerations">
                    {considerations.map((item, i) => <li key={i}>{item}</li>)}
                  </ul>
                )}
              </DetailSection>

              {detail.availability && (
                <DetailSection title="Availability">
                  <p className="swdetail__availability">{detail.availability}</p>
                </DetailSection>
              )}

              {detail.disclaimer && <p className="swdetail__disclaimer">{detail.disclaimer}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Evidence explainer ────────────────────────────────────────────────
   Shown behind the ⓘ next to a citation. It exists because a citation the
   reader cannot judge is decoration: this says plainly what the system
   prioritises, how old the research is allowed to be, and — most importantly
   — that none of it replaces a clinician. */

export function EvidenceInfoModal({ onClose }) {
  const overlayRef = useRef(null);

  useLockBodyScroll(true);
  useEscape(true, onClose);

  const onOverlayClick = (event) => {
    if (event.target === overlayRef.current) onClose();
  };

  const criteria = [
    'Priority: peer-reviewed research from the last 2 years',
    'If unavailable: supporting evidence from the last 5 years, when clinically relevant',
    'Before citing older landmark studies: search for a recent systematic review or meta-analysis that builds on them',
    'If no recent synthesis exists: landmark studies or clinical guidelines still widely accepted, clearly labelled',
    'Quality hierarchy: systematic reviews and meta-analyses, then clinical guidelines, then RCTs, then observational studies',
    'APA-formatted references with PMID, from PubMed, NIH, WHO and recognised medical organisations',
  ];

  return (
    <div className="swevidence__overlay" ref={overlayRef} onClick={onOverlayClick}>
      <div className="swevidence__panel" role="dialog" aria-modal="true" aria-label="Evidence and references">
        <header className="swevidence__header">
          <h3 className="swevidence__title">Evidence &amp; References</h3>
          <button type="button" className="swevidence__close" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="swevidence__body">
          <p className="swevidence__intro">
            To keep recommendations reliable and current, this system prioritises:
          </p>
          <ul className="swevidence__list">
            {criteria.map((item) => (
              <li key={item} className="swevidence__item">
                <span className="swevidence__check" aria-hidden="true">✅</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <div className="swevidence__disclaimer">
            <span aria-hidden="true">⚠️</span>
            <p>
              <strong>Important:</strong> these recommendations are AI-assisted and for
              information only. They do not replace professional medical advice, diagnosis or
              treatment. Always consult a qualified healthcare professional before starting,
              stopping or changing any supplement regimen.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}