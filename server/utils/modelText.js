/**
 * Model output rewritten into the ASCII the app's text checks are written in.
 *
 * Whether a completion uses a straight apostrophe or a typographic one is a
 * property of the vendor's sampler, not of the medicine — and it differs by
 * provider. Groq's model emits curly quotes, non-breaking hyphens and narrow
 * no-break spaces where Anthropic's emits ASCII, so any check written with an
 * ASCII apostrophe stops matching the moment traffic moves to the other account.
 *
 * That is not cosmetic. The grounding guards in planGrounding.js mask a DENIED
 * curative claim before they rewrite an asserted one, using can'?t, doesn'?t and
 * friends. Given "this can<TYP> cure it" the negation no longer matches, the
 * sentence reads as an unqualified curative claim, and the verifier rewrites a
 * correct medical disclaimer into nonsense. The mirror case: a curly quote is a
 * word boundary, so a "can" alternative matches inside "can<TYP>t" and a refusal
 * scores as an assertion.
 *
 * Normalising at the two seams that face outward — readCompletionText, where
 * provider bytes become app text, and verifyProse, which also sees transcripts
 * stored before this existed — keeps the invariant in one place instead of in
 * every regex that has to remember it. It is a spelling change, never a meaning
 * change: ASCII in is ASCII out, and no check becomes weaker.
 *
 * The classes below are built from code-point numbers rather than written as
 * literals on purpose. An invisible character in a source file is unreviewable —
 * and a dash typed into a character class is silently a range, which is how a
 * "list of spaces" becomes a match for half of Unicode.
 */

/** One character class covering `codes` and every code point in `ranges`. */
function characterClass(codes, ranges = []) {
  const chars = [...codes, ...ranges.flatMap(([from, to]) => {
    const out = [];
    for (let cp = from; cp <= to; cp += 1) out.push(cp);
    return out;
  })];
  return `[${chars.map((cp) => String.fromCodePoint(cp)).join('')}]`;
}

/** Global by construction: these all run through `String.replace` to strip a whole reply. */
const globalClass = (codes, ranges) => new RegExp(characterClass(codes, ranges), 'g');

// Curly apostrophes and their modifiers -> ' ; double quotes and low/high quotes -> ".
const CURLY_SINGLE = globalClass([0x2018, 0x2019, 0x201A, 0x201B]);
const CURLY_DOUBLE = globalClass([0x201C, 0x201D, 0x201E, 0x201F]);

// Non-breaking hyphen, no-break hyphen, figure dash, small em dash, minus sign.
// Deliberately NOT U+2013 or U+2014: those two are punctuation the app itself
// writes (its unsourced-statistic line carries an em dash), and every check that
// reads a dash as a separator already enumerates them — DOSE_NUMBER matches
// [-–—] and CLAUSE_SPLIT splits on [—–-]. Folding them would edit the app's own
// copy on a second verification pass and break the idempotence contract.
const DASHES = globalClass([0x2010, 0x2011, 0x2012, 0x2015, 0x2212]);

// Every space that is not U+0020: non-breaking, ogham, thin through hair, narrow
// no-break (what a formatter puts between "PMID:" and the digits), medium
// mathematical, ideographic.
const SPACES = globalClass([0x00A0, 0x1680, 0x202F, 0x205F, 0x3000], [[0x2000, 0x200A]]);

// Zero-width space, non-joiner, joiner, byte-order mark: invisible, and not content.
const INVISIBLE = globalClass([0xFEFF], [[0x200B, 0x200D]]);

// Ellipsis -> three dots, so a truncated bullet is not read as a sentence end.
const ELLIPSIS = globalClass([0x2026]);

/**
 * @param {unknown} text
 * @returns {string} the same words, spelled the way every downstream check reads them
 */
function normalizeModelText(text) {
  return String(text == null ? '' : text)
    .replace(CURLY_SINGLE, "'")
    .replace(CURLY_DOUBLE, '"')
    .replace(DASHES, '-')
    .replace(SPACES, ' ')
    .replace(ELLIPSIS, '...')
    .replace(INVISIBLE, '');
}

module.exports = { normalizeModelText };
