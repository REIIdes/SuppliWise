/**
 * Safe URL helpers.
 *
 * These exist because two kinds of values in this app reach a place where the
 * browser will happily execute or navigate to them, even though we do not
 * control them:
 *
 *   1. Resource URLs inside AI results (`seekingSupport.resources[].url`).
 *      A `javascript:` URL dropped straight into an <a href> runs script in
 *      our origin the moment the link is clicked — a stored XSS primitive,
 *      since the value is produced by the model, not by us.
 *
 *   2. `location.state.redirectTo`, which decides where the post-login hop
 *      lands. A crafted state value could otherwise turn sign-in into an
 *      open redirect (including `window.location.href = 'https://evil.com'`).
 *
 * Policy is allowlist-only: nothing is made safe by being escaped, it has to
 * actually be one of the shapes we expect.
 */

// Only navigational schemes. `javascript:`, `data:`, `vbscript:`, `file:` and
// friends are rejected outright.
const ALLOWED_SCHEMES = ['http:', 'https:'];

/**
 * Return a URL that is safe to put in an href, or null to render unlinked.
 * Accepts http(s) URLs and same-origin-relative paths.
 */
export function safeUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;

  // Drop control characters first: they defeat naive scheme checks
  // ("java\tscript:alert(1)" still executes in some contexts).
  // eslint-disable-next-line no-control-regex -- the control range IS the point here
  const normalized = raw.replace(/[\u0000-\u001F\u007F]/g, '');
  if (!normalized) return null;

  // Root-relative paths stay on our origin by definition.
  if (normalized.startsWith('/') && !normalized.startsWith('//')) return normalized;

  try {
    const parsed = new URL(normalized, window.location.origin);
    return ALLOWED_SCHEMES.includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Allow only an in-app, same-origin path for a post-login redirect.
 * Rejects absolute URLs (`https://…`), protocol-relative (`//evil.com`),
 * backslash tricks (`/\evil.com`) and anything that is not a string —
 * falling back to the app's default landing page instead.
 *
 * @param {*} value candidate redirect target from router location state
 * @param {string} [fallback='/dashboard'] where to go when the value is unsafe
 */
export function safeRedirectPath(value, fallback = '/dashboard') {
  if (typeof value !== 'string') return fallback;
  const raw = value.trim();
  if (!raw) return fallback;

  // Must be app-internal: single leading slash, not `//host`, not `/\host`,
  // and not a scheme-prefixed absolute URL.
  const isAppPath = raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\');
  if (!isAppPath) return fallback;

  // Never resume into an auth screen — that would strand the user in a loop.
  if (/^\/(login|signin|register|admin\/login)\/?(\?|#|$)/i.test(raw)) return fallback;

  return raw;
}
