/**
 * NOTIFICATION GLYPHS — one icon per accent family.
 *
 * The bell used to distinguish rows with a single ⚑ character, which meant one
 * urgent thing looked identical to every non-urgent thing. An icon tile per
 * family is what makes a panel scannable: somebody with twenty unread notices
 * finds the one support reply without reading twenty titles.
 *
 * Inline SVG rather than an icon dependency — the same call SupportInbox and
 * AdminSupportChats already make — so these inherit `currentColor`, scale with
 * font-size, and add nothing to the bundle.
 *
 * Sized in `em` and centred by the caller's tile; each one is drawn on the same
 * 24-unit grid with the same optical weight, so a row of mixed kinds reads as one
 * set rather than as unrelated marks.
 */
const GLYPHS = {
  // A support reply — a conversation, not a system event.
  support: (
    <>
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 21l1.9-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" />
      <path d="M8.6 10.4h6.8M8.6 13.8h4.2" />
    </>
  ),

  // A lock — account security.
  security: (
    <>
      <rect x="4" y="10.5" width="16" height="10.5" rx="2.5" />
      <path d="M7.8 10.5V7.4a4.2 4.2 0 0 1 8.4 0v3.1" />
      <path d="M12 14.6v2.4" />
    </>
  ),

  // A pulse over a heart line — a health review.
  health: (
    <>
      <path d="M20.4 5.6a5.1 5.1 0 0 0-7.2 0L12 6.8l-1.2-1.2a5.1 5.1 0 0 0-7.2 7.2l1.2 1.2L12 21l7.2-7.1 1.2-1.2a5.1 5.1 0 0 0 0-7.1z" />
      <path d="M3.6 12.4h3.6l1.5-2.6 2 5 1.7-3.2 1 1.8h3.2" />
    </>
  ),

  // A clipboard — an assessment, as opposed to a health concern about one.
  assessment: (
    <>
      <rect x="4.5" y="4.5" width="15" height="16" rx="2.5" />
      <path d="M9 4.5a1.6 1.6 0 0 1 1.6-1.6h2.8A1.6 1.6 0 0 1 15 4.5v.9H9z" />
      <path d="M8.6 11h6.8M8.6 14.6h4.4" />
    </>
  ),

  // A card — plans, upgrades, cancellations.
  billing: (
    <>
      <rect x="2.6" y="5" width="18.8" height="14" rx="2.6" />
      <path d="M2.6 10h18.8" />
      <path d="M6.4 14.6h3.4" />
    </>
  ),

  // Linked blocks — the ledger.
  chain: (
    <>
      <rect x="3" y="3.2" width="7.4" height="7.4" rx="2" />
      <rect x="13.6" y="3.2" width="7.4" height="7.4" rx="2" />
      <rect x="3" y="13.4" width="7.4" height="7.4" rx="2" />
      <path d="M17.3 13.4v7.4M13.6 17.1h7.4" />
    </>
  ),

  // A person — account state rather than account safety.
  account: (
    <>
      <circle cx="12" cy="8" r="3.8" />
      <path d="M4.6 20.4a7.4 7.4 0 0 1 14.8 0" />
    </>
  ),

  // A bell — anything with no family of its own.
  info: (
    <>
      <path d="M18 8.4a6 6 0 1 0-12 0c0 6.6-2.8 8.4-2.8 8.4h17.6S18 15 18 8.4" />
      <path d="M13.7 20.4a2 2 0 0 1-3.4 0" />
    </>
  ),
};

/** Fallback family, so an unknown key renders a glyph rather than nothing. */
const FALLBACK = 'info';

/**
 * @param {string} kind  A key from `visualKind`.
 * @param {object} props Forwarded to the <svg>.
 */
export default function NotificationGlyph({ kind, ...props }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {GLYPHS[kind] || GLYPHS[FALLBACK]}
    </svg>
  );
}

export { GLYPHS };