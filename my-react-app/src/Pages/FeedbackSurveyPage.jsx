import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../Components/Navbar/Navbar';
import { getSurveyInstruments, submitSurveyResponse, getToken } from '../api';
import './FeedbackSurveyPage.css';

/*
 * The evaluation questionnaires (usability / efficiency / satisfaction).
 *
 * The items are rendered exactly as the server defines them — this page never
 * hard-codes a question, so the instrument a respondent answers is always the
 * standardized instrument on record (SUS verbatim, ISO 9241-11 adaptations),
 * and scoring/reverse-scoring happens server-side where it is unit-tested.
 */
function FeedbackSurveyPage() {
  const navigate = useNavigate();
  const [instruments, setInstruments] = useState([]);
  const [answers, setAnswers] = useState({}); // instrumentId -> { itemIndex: value }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState('');
  const [results, setResults] = useState({}); // instrumentId -> score

  useEffect(() => {
    if (!getToken()) { navigate('/login', { replace: true }); return; }
    let cancelled = false;
    getSurveyInstruments()
      .then((list) => {
        if (cancelled) return;
        setInstruments(list);
        setAnswers(Object.fromEntries(list.map((i) => [i.id, {}])));
      })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load the questionnaires.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [navigate]);

  const setValue = useCallback((instrumentId, itemIndex, value) => {
    setAnswers((prev) => ({
      ...prev,
      [instrumentId]: { ...(prev[instrumentId] || {}), [itemIndex]: value },
    }));
  }, []);

  const submit = useCallback(async (instrument) => {
    const picked = answers[instrument.id] || {};
    const values = instrument.items.map((_, i) => picked[i]);
    if (values.some((v) => !v)) {
      setError(`Please answer all ${instrument.items.length} statements in "${instrument.title}".`);
      return;
    }
    setError('');
    setSubmitting(instrument.id);
    try {
      const res = await submitSurveyResponse(instrument.id, values);
      setResults((prev) => ({ ...prev, [instrument.id]: res.score }));
    } catch (err) {
      setError(err.message || 'Could not submit your responses.');
    } finally {
      setSubmitting('');
    }
  }, [answers]);

  return (
    <div className="feedback-page">
      <Navbar />
      <main className="feedback-main">
        <header className="feedback-header">
          <h1>Help Validate SuppliWise</h1>
          <p>
            Standardized research questionnaires — the System Usability Scale and
            ISO 9241-11 efficiency and satisfaction scales. Your responses measure
            the system&apos;s usability, efficiency and satisfaction for the study;
            they never change your health plan.
          </p>
        </header>

        {loading && <div className="feedback-status">Loading questionnaires…</div>}
        {error && <div className="feedback-error" role="alert">{error}</div>}

        {instruments.map((instrument) => {
          const done = results[instrument.id];
          return (
            <section key={instrument.id} className="feedback-card">
              <div className="feedback-card-head">
                <div>
                  <h2>{instrument.title}</h2>
                  <span className={`feedback-chip chip-${instrument.measures}`}>{instrument.measures}</span>
                </div>
                {done !== undefined && (
                  <div className="feedback-score" title="Scored on the instrument's published 0-100 scale">
                    Score: <strong>{done}</strong>/100
                  </div>
                )}
              </div>
              <p className="feedback-source">Source: {instrument.source}</p>
              <ol className="feedback-items">
                {instrument.items.map((item, i) => (
                  <li key={item.id} className="feedback-item">
                    <span className="feedback-item-text">{item.text}</span>
                    <div className="feedback-scale" role="radiogroup" aria-label={item.text}>
                      {[1, 2, 3, 4, 5].map((v) => (
                        <label key={v} className={`feedback-radio ${answers[instrument.id]?.[i] === v ? 'selected' : ''}`}>
                          <input
                            type="radio"
                            name={`${instrument.id}-${i}`}
                            value={v}
                            checked={answers[instrument.id]?.[i] === v}
                            onChange={() => setValue(instrument.id, i, v)}
                            disabled={done !== undefined}
                          />
                          <span>{v}</span>
                        </label>
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
              <div className="feedback-card-foot">
                <span className="feedback-anchors">1 = {instrument.scale.anchors[0].slice(4)} · 5 = {instrument.scale.anchors[4].slice(4)}</span>
                {done === undefined && (
                  <button
                    type="button"
                    className="feedback-submit"
                    onClick={() => submit(instrument)}
                    disabled={submitting === instrument.id}
                  >
                    {submitting === instrument.id ? 'Submitting…' : `Submit ${instrument.title}`}
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </main>
    </div>
  );
}

export default FeedbackSurveyPage;
