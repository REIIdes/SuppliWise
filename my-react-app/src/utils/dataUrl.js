/**
 * `data:` URL helpers — turning an inline image payload into something the
 * browser will let you actually *do* something with.
 *
 * WHY THIS EXISTS
 * ---------------
 * A proof-of-payment receipt is stored as a base64 `data:` URL
 * (`server/utils/subscriptionRequests.js` → `parseProofImage`). Rendering that
 * in an `<img src>` is fine and always worked. Putting it in an `<a href>` and
 * opening a new tab is NOT: every current browser (Chrome, Edge, Firefox,
 * Safari) refuses *top-level navigation* to a `data:` URL as an anti-abuse
 * measure, because a page that can navigate you to arbitrary inline content
 * can be used for phishing and for spoofing another origin's look.
 *
 * The symptom is a link that appears completely broken: the tab opens, and
 * there is no image in it and no error message either. Nothing in the console
 * points at the cause, because from the page's point of view the click worked
 * exactly as authored.
 *
 * The fix is to stop navigating to the `data:` URL. Two things replace it, and
 * both need this module:
 *
 *   1. An in-app viewer (`Components/ImageLightbox`) which renders the `data:`
 *      URL directly. No navigation, so no browser restriction is involved.
 *   2. A real `Blob` (via `URL.createObjectURL`) for the two things that
 *      genuinely must leave the page: "Open in new tab" and "Download". A
 *      `blob:` URL is same-origin by construction, so browsers allow both.
 *
 * WHY NOT `fetch(dataUrl).then(r => r.blob())`
 * --------------------------------------------
 * It is the obvious one-liner and it does not work in this app. `fetch` is
 * governed by the `connect-src` directive, and `index.html` ships:
 *
 *     connect-src 'self' http: https: ws: wss:
 *
 * `data:` is not in that list, so the fetch is refused and every download
 * button dies silently. Decoding the base64 by hand uses `atob`, which is a
 * plain DOM API that no CSP directive governs.
 */

/** Mime types we are willing to hand a Blob for, mapped to a file extension. */
const EXTENSION_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

/**
 * The strict base64 alphabet. `atob` is lenient — it ignores whitespace and
 * tolerates some malformed input — so the shape is checked before decoding
 * rather than after. This is the same alphabet the server enforces on upload
 * (`PROOF_DATA_URL` in server/utils/subscriptionRequests.js); repeating it here
 * means a value that somehow bypassed the server still cannot smuggle anything
 * unexpected into a Blob.
 */
const BASE64_ALPHABET = /^[A-Za-z0-9+/]*={0,2}$/;

/** A mime we are prepared to reconstruct. Anything else is refused outright. */
const SAFE_IMAGE_MIME = /^(?:image\/png|image\/jpeg|image\/webp|image\/gif|image\/bmp|image\/avif)$/;

/**
 * Split a `data:` URL into its parts.
 *
 * @param {*} value
 * @returns {{mime: string, isBase64: boolean, payload: string}|null}
 *          null for anything that is not a base64 image data URL.
 */
export function parseDataUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!/^data:/i.test(raw)) return null;

  // The comma is the only reliable separator: everything before it is the
  // media type plus parameters, everything after is the payload. Searching for
  // a comma rather than splitting on ';' first is what makes a base64 payload
  // (which is full of neither) safe to handle.
  const comma = raw.indexOf(',');
  if (comma < 0) return null;

  const header = raw.slice('data:'.length, comma);
  const payload = raw.slice(comma + 1);
  if (!payload) return null;

  const segments = header.split(';');
  const mime = (segments.shift() || '').trim().toLowerCase();
  const isBase64 = segments.some((part) => part.trim().toLowerCase() === 'base64');

  return { mime, isBase64, payload };
}

/**
 * Decode a base64 string to bytes, or null when it is not clean base64.
 *
 * Structural validity (length a multiple of 4, padding in the right place) is
 * left to `atob`, which rejects it by throwing. Re-deriving that rule here
 * would be a second, worse copy of it: an early version subtracted the padding
 * before testing the modulus, which is not how base64 works and threw away a
 * perfectly valid 92-character 1×1 PNG.
 *
 * @param {string} value
 * @returns {Uint8Array|null}
 */
export function base64ToBytes(value) {
  if (typeof value !== 'string') return null;
  // FileReader output has no line breaks, but a hand-built payload can, and a
  // stray newline would fail the alphabet check for no good reason.
  const compact = value.replace(/\s+/g, '');
  if (!compact || !BASE64_ALPHABET.test(compact)) return null;

  let binary;
  try {
    binary = atob(compact);
  } catch {
    return null;
  }
  if (!binary.length) return null;

  // atob yields one character per byte, so this is a straight widening. Done
  // by hand rather than with Uint8Array.from(map) because the mapped form
  // allocates a closure call per byte, which is measurable on a 2 MB receipt.
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * Rebuild a `data:` image URL as a real Blob.
 *
 * @param {*} value a base64 image data URL
 * @returns {Blob|null} null when the value is not one we will handle
 */
export function dataUrlToBlob(value) {
  const parsed = parseDataUrl(value);
  if (!parsed || !parsed.isBase64) return null;
  if (!SAFE_IMAGE_MIME.test(parsed.mime)) return null;

  const bytes = base64ToBytes(parsed.payload);
  if (!bytes) return null;

  return new Blob([bytes], { type: parsed.mime });
}

/**
 * A `blob:` object URL for a data URL — the form that CAN be opened in a new
 * tab or downloaded, which a `data:` URL cannot.
 *
 * The caller OWNS the returned URL and must revoke it. The lightbox holds one
 * for its lifetime and revokes it on close; a component that calls this on
 * every render will leak the whole decoded image per render.
 *
 * @param {*} value a base64 image data URL
 * @returns {string} an object URL, or '' when the value is unusable
 */
export function dataUrlToObjectUrl(value) {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return '';
  const blob = dataUrlToBlob(value);
  if (!blob) return '';
  try {
    return URL.createObjectURL(blob);
  } catch {
    return '';
  }
}

/** Revoke an object URL, tolerating a value that is not one. */
export function revokeObjectUrl(url) {
  if (!url || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Already revoked, or never a URL we made. Nothing to recover from.
  }
}

/**
 * The file extension for a data URL's mime type, or 'img' when unknown.
 * @param {*} value a base64 image data URL
 * @returns {string}
 */
export function extensionForDataUrl(value) {
  const parsed = parseDataUrl(value);
  return EXTENSION_BY_MIME[parsed?.mime] || 'img';
}

/**
 * Build a download filename that is safe on every filesystem.
 *
 * @param {object} opts
 * @param {string} [opts.base]   stem, e.g. 'payment-proof'
 * @param {string} [opts.stamp]  appended so repeat downloads do not collide
 * @param {*}      opts.src      the data URL, for the extension
 * @returns {string}
 */
export function dataUrlFileName({ base = 'image', stamp = '', src = '' } = {}) {
  // No dot is allowed in the stem. Keeping one would let a base of `..`
  // survive into the finished name, and a filename containing `..` is a path
  // traversal primitive for any consumer that joins it onto a directory. A
  // stem never needs a dot — the extension supplies the only one that matters.
  const safeBase = String(base)
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'image';
  const safeStamp = String(stamp).replace(/[^a-zA-Z0-9-]/g, '').replace(/-+/g, '-');
  const suffix = safeStamp ? `-${safeStamp}` : '';
  return `${safeBase}${suffix}.${extensionForDataUrl(src)}`;
}

/**
 * A short human summary of an image data URL, for a caption.
 * @param {*} value
 * @returns {{mime: string, ext: string, kilobytes: number}}
 */
export function describeDataUrl(value) {
  const parsed = parseDataUrl(value);
  const bytes = parsed && parsed.isBase64 ? base64ToBytes(parsed.payload)?.length ?? 0 : 0;
  const ext = EXTENSION_BY_MIME[parsed?.mime] || 'img';
  return {
    mime: parsed?.mime || '',
    ext: ext.toUpperCase(),
    kilobytes: Math.max(1, Math.round(bytes / 1024)),
  };
}
