/**
 * Marketplace quantity clamping.
 *
 * Extracted from MarketplacePage so the one piece of arithmetic behind the
 * quantity stepper can be pinned by a test instead of only by clicking around.
 *
 * WHAT THIS IS REALLY TESTING
 * --------------------------
 * That the number the BUY BUTTON sends can never disagree with the number the
 * stepper is showing, for any input the field can produce.
 *
 * The old markup bound a bare <input type="number"> straight to component
 * state: clearing it left `''` in state while the `value || 1` fallback
 * rendered "1", and typing 9999 kept a quantity no listing has in stock. Either
 * one only fails at the server, after the click, as a generic toast. Every
 * path through a text field — empty, zero, negative, mid-typing, out of range —
 * now has to resolve to a whole number inside [1, stock].
 */

/**
 * Coerce a raw field value to a whole number inside [min, max].
 *
 * A blank or unparseable field falls back to `min` (1) rather than to 0 or NaN:
 * the stepper must always display an orderable quantity, so there is no state
 * in which the control reads as invalid.
 *
 * `max` is the listing's stock, which is 0 for a sold-out item. That is passed
 * in already raised to 1 by the caller, so a sold-out control shows 1 while
 * being disabled — it never shows 0, which reads as "zero available" twice.
 */
export function clampQty(raw, min = 1, max = 1) {
  const upper = Math.max(min, max);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return min;
  return Math.min(upper, Math.max(min, n));
}
