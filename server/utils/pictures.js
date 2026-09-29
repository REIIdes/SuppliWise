/**
 * Profile and banner images live on DISK, not inside the user document.
 *
 * WHY
 * ---
 * These fields used to hold a raw `data:image/...;base64,...` string in
 * MongoDB. That made a single account's document ~3 MB (measured: one real
 * account carried a 2,962,602-character bannerPicture), and it broke sign-in
 * completely:
 *
 *   • `POST /api/auth/login` did `User.findOne({ email })` with no projection,
 *     so every sign-in pulled the whole multi-megabyte document.
 *   • It then called `user.save()` to stamp "last seen", which wrote the same
 *     multi-megabyte document straight back.
 *
 * Over the project's Atlas link each of those operations cost ~30.5 s (see
 * `docs/` note below) while a `ping` on the same connection took 36 ms — the
 * cluster was healthy, the payload was simply enormous. Login therefore needed
 * well over a minute, the client gave up, and the socket timeout was then
 * misreported to the user as "We could not reach our servers just now."
 * The blob also rode back in every auth JSON response and was written into
 * `localStorage`, which only holds ~5 MB in total.
 *
 * The document now stores only a URL (`/pictures/<file>`). Nothing about
 * rendering changes: `<img src>` and `background-image: url()` accept an
 * absolute http(s) URL exactly as happily as a data URL, so the existing
 * client components keep working once they resolve the path against the API
 * origin (see `my-react-app/src/utils/pictureUrl.js`).
 *
 * Files are content-addressed (`<owner>-<kind>-<sha256-prefix>.<ext>`), which
 * gives three properties for free:
 *   • Re-uploading the same image reuses the same file, so the directory
 *     cannot grow without bound as users re-pick the same avatar.
 *   • The URL changes whenever the bytes change, so responses can be cached
 *     immutably forever and a replaced image is never served from a stale
 *     cache.
 *   • Two accounts uploading identical bytes share one file.
 *
 * Values that are already URLs pass through untouched, so this is idempotent
 * and a client that echoes a previously-returned path back is not re-encoded.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Absolute path of the directory holding the image files. */
const PICTURE_DIR = path.resolve(__dirname, '..', 'uploads', 'pictures');

/** Public URL prefix the files are served under (see index.js). */
const PUBLIC_PATH = '/pictures';

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Caps on the DECODED image. These are the real limits (a 2 MB avatar) — the
 * old check compared the base64 *string* length, which quietly rejected a
 * legitimate 2 MB JPEG (2 MB of raw bytes is ~2.7 MB once base64-encoded)
 * while the client happily offered it. The limit is on what we decode, and the
 * encoded size is separately bounded so a hostile body cannot make us
 * allocate an unbounded string before we get to check anything.
 */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MAX_BANNER_BYTES = 3 * 1024 * 1024;

/** Hard ceiling on an accepted base64 payload, before decoding. */
const MAX_ENCODED_CHARS = 12 * 1024 * 1024;

/**
 * Anything at or above this size is a legacy inline blob. Used by
 * `safePictureValue` so an auth response can never again ship megabytes, even
 * for a document the migration has not reached yet.
 */
const INLINE_BLOB_CHARS = 64 * 1024;

const DATA_URL_RE = /^data:([a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*)?(;charset=[^;,]*)?(;base64)?,([\s\S]*)$/i;

/** True when `value` is an inline `data:` payload rather than a stored path. */
function isDataUrl(value) {
  return typeof value === 'string' && /^data:/i.test(value.trim());
}

/** True when `value` is already one of our on-disk paths. */
function isStoredPath(value) {
  return typeof value === 'string' && value.trim().startsWith(`${PUBLIC_PATH}/`);
}

function ensureDir() {
  fs.mkdirSync(PICTURE_DIR, { recursive: true });
}

/**
 * Split a `data:` URL into its mime type and decoded bytes.
 * Returns null for anything that is not a recognisable base64 image URL.
 */
function parseDataUrl(value) {
  if (!isDataUrl(value)) return null;
  const match = DATA_URL_RE.exec(value.trim());
  if (!match) return null;

  const mime = String(match[1] || '').toLowerCase();
  const isBase64 = Boolean(match[3]);
  const payload = match[4] || '';
  if (!isBase64 || !payload) return null;

  const ext = EXT_BY_MIME[mime];
  if (!ext) return null; // Not an image type we are willing to write to disk.

  // Bound the allocation: a caller can send an arbitrarily long string.
  if (payload.length > MAX_ENCODED_CHARS) {
    const err = new Error('Picture is too large.');
    err.statusCode = 413;
    throw err;
  }

  const buffer = Buffer.from(payload, 'base64');
  if (!buffer.length) return null;
  return { mime, ext, buffer };
}

/** The content-addressed filename for a set of bytes. */
function fileNameFor(ownerId, kind, buffer, ext) {
  const digest = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  const safeOwner = String(ownerId || 'anon').replace(/[^a-zA-Z0-9_-]/g, '');
  const safeKind = String(kind || 'pic').replace(/[^a-zA-Z0-9_-]/g, '');
  return `${safeOwner}-${safeKind}-${digest}.${ext}`;
}

/**
 * Persist a picture and return the value to store on the document.
 *
 * Accepts, and returns, one of three things:
 *   • `''`          — the caller is clearing the picture.
 *   • a stored path — the caller sent back a path we already issued, or an
 *                    absolute URL; both pass through untouched.
 *   • a data URL    — decoded, written to disk, and replaced by its path.
 *
 * @param {object}  opts
 * @param {string}  opts.ownerId  owning account id, namespaced into the filename
 * @param {string}  opts.kind     'profile' | 'banner'
 * @param {*}       opts.value    raw value from the request body
 * @param {number} [opts.maxBytes] decoded-size cap for this kind
 * @returns {string} value to persist on the document
 * @throws  {Error} with `.statusCode` 400/413 when the payload is unusable
 */
function storePicture({ ownerId, kind, value, maxBytes }) {
  // Explicit clear. Done before any other branch so an empty string never
  // reaches the "is this already stored?" passthrough below.
  if (value === '' || value === null || value === undefined) return '';

  if (typeof value !== 'string') {
    const err = new Error('Picture must be a string.');
    err.statusCode = 400;
    throw err;
  }

  const trimmed = value.trim();

  // Already a stored path or an absolute URL — nothing to decode. This keeps
  // the endpoint idempotent and lets a client round-trip our own value.
  if (isStoredPath(trimmed) || /^https?:\/\//i.test(trimmed)) return trimmed;

  if (!isDataUrl(trimmed)) {
    const err = new Error('Picture must be an image data URL.');
    err.statusCode = 400;
    throw err;
  }

  const parsed = parseDataUrl(trimmed);
  if (!parsed) {
    const err = new Error('Picture must be a base64 PNG, JPEG, WebP or GIF.');
    err.statusCode = 400;
    throw err;
  }

  const cap = Number.isFinite(maxBytes)
    ? maxBytes
    : kind === 'banner' ? MAX_BANNER_BYTES : MAX_AVATAR_BYTES;

  if (parsed.buffer.length > cap) {
    const err = new Error(
      kind === 'banner'
        ? 'Banner image is too large (max 3 MB).'
        : 'Profile picture is too large (max 2 MB).'
    );
    err.statusCode = 413;
    throw err;
  }

  ensureDir();
  const name = fileNameFor(ownerId, kind, parsed.buffer, parsed.ext);
  const target = path.join(PICTURE_DIR, name);

  // Content-addressed, so an existing file with this name already holds
  // exactly these bytes — writing again would be wasted I/O.
  if (!fs.existsSync(target)) {
    // Write to a temp name and rename, so a concurrent reader can never observe
    // a half-written file under the final name.
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, parsed.buffer);
    fs.renameSync(tmp, target);
  }

  return `${PUBLIC_PATH}/${name}`;
}

/**
 * Make a picture value safe to put in an API response.
 *
 * A stored path or URL is returned as-is. An inline `data:` payload is only
 * returned while it is small — the legitimate case of a client previewing an
 * unsaved image. A multi-megabyte one is dropped to `''` instead, so that even
 * a document the migration has not converted yet cannot turn a sign-in
 * response into a multi-megabyte download.
 *
 * @param {*} value
 * @returns {string}
 */
function safePictureValue(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (isDataUrl(trimmed) && trimmed.length > INLINE_BLOB_CHARS) return '';
  return trimmed;
}

module.exports = {
  PICTURE_DIR,
  PUBLIC_PATH,
  MAX_AVATAR_BYTES,
  MAX_BANNER_BYTES,
  INLINE_BLOB_CHARS,
  isDataUrl,
  isStoredPath,
  parseDataUrl,
  storePicture,
  safePictureValue,
};
