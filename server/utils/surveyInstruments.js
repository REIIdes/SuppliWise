/**
 * The standardized research questionnaires SuppliWise administers.
 *
 * WHY THIS EXISTS
 * ---------------
 * The evaluation instruments (usability, efficiency, satisfaction) must be
 * STANDARDIZED, not invented for the study — a locally-written questionnaire
 * has no established validity. So each instrument here is either a published,
 * internationally validated scale used verbatim, or items adapted from the
 * named standard, and the module carries the scoring rules that make them
 * comparable to published results:
 *
 *   SUS          — the System Usability Scale (Brooke, 1986): the 10 standard
 *                  items, the standard alternating 1-5 agreement scale, the
 *                  standard scoring (odd items x-1, even items 5-x, sum x 2.5)
 *                  producing a 0-100 score with 68 as the accepted average.
 *   EFFICIENCY   — 4 perceived-efficiency items adapted from the efficiency
 *                  quality-in-use dimension of ISO 9241-11:2018, scored as a
 *                  0-100 transform of the mean.
 *   SATISFACTION — 5 satisfaction items adapted from the satisfaction
 *                  dimension of ISO 9241-11:2018, same transform.
 *
 * Local validation (expert content review + Cronbach's alpha on collected
 * responses) is computed from real data by utils/surveyStats.js and exposed
 * through GET /api/survey/validation — the instruments are shipped with
 * `localValidation: 'pending'` rather than a claimed alpha nobody computed.
 */

const AGREEMENT_ANCHORS = [
  '1 - Strongly disagree',
  '2 - Disagree',
  '3 - Neutral',
  '4 - Agree',
  '5 - Strongly agree',
];

/** The 10 canonical SUS items, in canonical order, with reverse-scoring flags. */
const SUS = {
  id: 'sus',
  title: 'System Usability Scale (SUS)',
  measures: 'usability',
  source: 'Brooke, J. (1996). "SUS: A "quick and dirty" usability scale". In: Usability Evaluation in Industry. Taylor & Francis.',
  scale: { min: 1, max: 5, anchors: AGREEMENT_ANCHORS },
  scoreRange: { min: 0, max: 100 },
  benchmark: 'A score of 68 is the established average across thousands of administrations; >= 80.3 is in the top 10%.',
  items: [
    { id: 1, text: 'I think that I would like to use this system frequently.', reverse: false },
    { id: 2, text: 'I found the system unnecessarily complex.', reverse: true },
    { id: 3, text: 'I thought the system was easy to use.', reverse: false },
    { id: 4, text: 'I think that I would need the support of a technical person to be able to use this system.', reverse: true },
    { id: 5, text: 'I found the various functions in this system were well integrated.', reverse: false },
    { id: 6, text: 'I thought there was too much inconsistency in this system.', reverse: true },
    { id: 7, text: 'I would imagine that I would use this system very often.', reverse: false },
    { id: 8, text: 'I found the system very cumbersome to use.', reverse: true },
    { id: 9, text: 'I felt very confident using the system.', reverse: false },
    { id: 10, text: 'I needed to learn a lot of things before I could get going with this system.', reverse: true },
  ],
};

/**
 * SUS scoring, exactly as published: odd items contribute (value - 1), even
 * items contribute (5 - value); the sum of the ten contributions is doubled
 * and a half (x 2.5) to land on a 0-100 scale.
 */
function scoreSUS(values) {
  if (!Array.isArray(values) || values.length !== SUS.items.length) return null;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = Number(values[i]);
    if (!Number.isInteger(v) || v < 1 || v > 5) return null;
    sum += i % 2 === 0 ? v - 1 : 5 - v;
  }
  return Math.round(sum * 2.5 * 10) / 10;
}

const LIKERT_TRANSFORM = (meanValue) => Math.round(((meanValue - 1) / 4) * 1000) / 10;

/** Perceived-efficiency items adapted from ISO 9241-11:2018 (efficiency in quality-in-use). */
const EFFICIENCY = {
  id: 'efficiency',
  title: 'Perceived Efficiency Scale (ISO 9241-11 adapted)',
  measures: 'efficiency',
  source: 'Adapted from ISO 9241-11:2018, quality-in-use dimension "efficiency"; 4-point task-performance statements on a 5-point agreement scale.',
  scale: { min: 1, max: 5, anchors: AGREEMENT_ANCHORS },
  scoreRange: { min: 0, max: 100 },
  benchmark: 'Higher is better; reported as a 0-100 transform of the item mean.',
  items: [
    { id: 1, text: 'I was able to complete my health assessment quickly.', reverse: false },
    { id: 2, text: 'Finding my supplement plan and daily schedule was fast.', reverse: false },
    { id: 3, text: 'The steps needed to track my daily intake were efficient.', reverse: false },
    { id: 4, text: 'Overall, the system saved me time compared to doing this manually.', reverse: false },
  ],
};

/** Satisfaction items adapted from ISO 9241-11:2018 (satisfaction in quality-in-use). */
const SATISFACTION = {
  id: 'satisfaction',
  title: 'Satisfaction Scale (ISO 9241-11 adapted)',
  measures: 'satisfaction',
  source: 'Adapted from ISO 9241-11:2018, quality-in-use dimension "satisfaction"; 5 statements on a 5-point agreement scale.',
  scale: { min: 1, max: 5, anchors: AGREEMENT_ANCHORS },
  scoreRange: { min: 0, max: 100 },
  benchmark: 'Higher is better; reported as a 0-100 transform of the item mean.',
  items: [
    { id: 1, text: 'I am satisfied with the quality of the recommendations I received.', reverse: false },
    { id: 2, text: 'The health information presented to me was clear and trustworthy.', reverse: false },
    { id: 3, text: 'The system addressed my personal health needs well.', reverse: false },
    { id: 4, text: 'I feel confident recommending SuppliWise to others.', reverse: false },
    { id: 5, text: 'Overall, I am satisfied using SuppliWise.', reverse: false },
  ],
};

/** Forward-scored Likert instruments: mean -> 0-100. */
function scoreLikert(instrument, values) {
  if (!Array.isArray(values) || values.length !== instrument.items.length) return null;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = Number(values[i]);
    if (!Number.isInteger(v) || v < instrument.scale.min || v > instrument.scale.max) return null;
    sum += v;
  }
  return LIKERT_TRANSFORM(sum / values.length);
}

const INSTRUMENTS = [SUS, EFFICIENCY, SATISFACTION];

/** Validate one answer set against one instrument and score it. Returns {error} or {score, reversed}. */
function scoreInstrument(instrumentId, values) {
  const instrument = INSTRUMENTS.find((i) => i.id === instrumentId);
  if (!instrument) return { error: `Unknown instrument: ${instrumentId}` };
  const score = instrument.id === 'sus' ? scoreSUS(values) : scoreLikert(instrument, values);
  if (score === null) {
    return { error: `${instrument.id} requires exactly ${instrument.items.length} integer answers from ${instrument.scale.min} to ${instrument.scale.max}.` };
  }
  // The reverse-scored columns, flipped, so the matrix handed to
  // cronbachAlpha() is on a common direction (a requirement of the statistic).
  const reversed = values.map((v, i) => (instrument.items[i].reverse ? 6 - v : v));
  return { instrument, score, reversed };
}

module.exports = {
  INSTRUMENTS,
  SUS,
  EFFICIENCY,
  SATISFACTION,
  scoreSUS,
  scoreLikert,
  scoreInstrument,
};
