/**
 * dataUrl — rebuilding an inline image payload as a Blob the browser will
 * actually let you open or download.
 *
 * Run: npm test
 *
 * The failure this guards against is the "Open full size" link that opens an
 * empty tab. `data:` URLs cannot be top-level navigation targets in any
 * current browser, so an <a href="data:image/png;base64,…"> opens a tab with
 * nothing in it and no error anywhere. The preview <img> keeps working, which
 * is exactly why it reads as "the image is broken" rather than "the link is
 * broken".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base64ToBytes,
  dataUrlFileName,
  dataUrlToBlob,
  describeDataUrl,
  extensionForDataUrl,
  parseDataUrl,
  revokeObjectUrl,
} from './dataUrl.js';

// 1x1 transparent PNG — the smallest real image, used as a valid fixture.
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('parses mime, encoding and payload out of a data URL', () => {
  const parsed = parseDataUrl(PNG_1PX);
  assert.equal(parsed.mime, 'image/png');
  assert.equal(parsed.isBase64, true);
  assert.ok(parsed.payload.startsWith('iVBORw0KGgo'));
});

test('the mime is normalised, so image/PNG and image/JPEG both match', () => {
  // The server lower-cases what it stores, but a hand-built body or a future
  // change upstream should not be able to slip a differently-cased type past
  // the allowlist by accident.
  assert.equal(parseDataUrl('data:image/PNG;base64,AAAA').mime, 'image/png');
  assert.equal(parseDataUrl('DATA:image/JPEG;base64,AAAA').mime, 'image/jpeg');
});

test('a non-base64 data URL is reported as such, not silently accepted', () => {
  const parsed = parseDataUrl('data:image/png,not-base64');
  assert.equal(parsed.isBase64, false);
  // …and it must not become a Blob, because the bytes would be garbage.
  assert.equal(dataUrlToBlob('data:image/png,not-base64'), null);
});

test('rejects values that are not data URLs at all', () => {
  assert.equal(parseDataUrl('https://example.com/a.png'), null);
  assert.equal(parseDataUrl('/pictures/a.png'), null);
  assert.equal(parseDataUrl('javascript:alert(1)'), null);
  assert.equal(parseDataUrl(''), null);
  assert.equal(parseDataUrl('   '), null);
  assert.equal(parseDataUrl(null), null);
  assert.equal(parseDataUrl(undefined), null);
  assert.equal(parseDataUrl(42), null);
  assert.equal(parseDataUrl({}), null);
});

test('rejects a data URL with no comma, which has no payload boundary', () => {
  assert.equal(parseDataUrl('data:image/png;base64'), null);
});

test('rejects a data URL with an empty payload', () => {
  assert.equal(parseDataUrl('data:image/png;base64,'), null);
});

test('decodes base64 to the exact bytes', () => {
  const bytes = base64ToBytes('QUJD'); // "ABC"
  assert.deepEqual([...bytes], [65, 66, 67]);
});

test('decodes base64 that carries newlines from a hand-built payload', () => {
  // A line-wrapped payload is valid base64 and must not be refused.
  const bytes = base64ToBytes('QU\nJD\n');
  assert.deepEqual([...bytes], [65, 66, 67]);
});

test('rejects base64 outside the strict alphabet', () => {
  // atob is lenient and would decode some of these anyway. The point of the
  // check is to refuse them, not to discover that atob coped.
  assert.equal(base64ToBytes('QUJ$'), null);
  assert.equal(base64ToBytes('QU JD!'), null);
  assert.equal(base64ToBytes('QUJD==='), null);
});

test('rejects base64 whose length cannot be a whole number of bytes', () => {
  // 5 characters is 1 past a valid group of 4 and cannot be produced by
  // encoding any byte sequence, so atob refuses it. Structural validity is
  // atob's job, not a second hand-rolled copy of the rule.
  assert.equal(base64ToBytes('QUJDR'), null);
  assert.equal(base64ToBytes('QUJD='), null);
  assert.equal(base64ToBytes(''), null);
});

test('builds a Blob carrying the original mime, from real bytes', async () => {
  const blob = dataUrlToBlob(PNG_1PX);
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, 'image/png');
  // The point of the whole exercise: real bytes, not a string that a browser
  // will refuse to navigate to. The PNG magic number proves the payload came
  // through intact rather than being re-encoded from the URL text.
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('refuses a non-image mime, so only pictures become Blobs', () => {
  // A `data:text/html` payload turned into a Blob and opened in a new tab would
  // be a same-origin document. Allowing it here would undo the very protection
  // that made Blob URLs safe.
  assert.equal(dataUrlToBlob('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='), null);
  assert.equal(dataUrlToBlob('data:application/javascript;base64,YWxlcnQoMSk='), null);
  // `image/svg+xml` is deliberately absent, matching the server: an SVG is a
  // script vector, so rendering one from an untrusted upload is a stored XSS.
  assert.equal(dataUrlToBlob('data:image/svg+xml;base64,PHN2Zy8+'), null);
});

test('refuses a corrupt image payload rather than returning an empty Blob', () => {
  assert.equal(dataUrlToBlob('data:image/png;base64,@@@@'), null);
  assert.equal(dataUrlToBlob('data:image/png;base64'), null);
});

test('maps the mime to a sensible file extension', () => {
  assert.equal(extensionForDataUrl(PNG_1PX), 'png');
  assert.equal(extensionForDataUrl('data:image/jpeg;base64,QUJD'), 'jpg');
  assert.equal(extensionForDataUrl('data:image/webp;base64,QUJD'), 'webp');
  // Unknown types get a neutral extension rather than an empty one, so the
  // filename is never "receipt." with a dangling dot.
  assert.equal(extensionForDataUrl('data:image/heic;base64,QUJD'), 'img');
  assert.equal(extensionForDataUrl('nonsense'), 'img');
});

test('builds a filename that is safe on every filesystem', () => {
  const name = dataUrlFileName({ base: 'payment proof/../../etc', stamp: '2026 09 29', src: PNG_1PX });
  assert.equal(name, 'payment-proof-etc-20260929.png');
  // Nothing that could escape a directory or split the name.
  assert.ok(!name.includes('/'));
  assert.ok(!name.includes('\\'));
  assert.ok(!name.includes('..'));
});

test('a filename always has an extension, even with nothing usable to name it', () => {
  assert.equal(dataUrlFileName({ src: PNG_1PX }), 'image.png');
  assert.equal(dataUrlFileName({ base: '///', src: PNG_1PX }), 'image.png');
  assert.equal(dataUrlFileName(), 'image.img');
});

test('describes an image for a caption, without rounding to zero', () => {
  const info = describeDataUrl(PNG_1PX);
  assert.equal(info.mime, 'image/png');
  assert.equal(info.ext, 'PNG');
  // The 1px fixture is ~70 bytes. Rounded naively that is 0, and a caption
  // reading "0 KB" tells a reviewer nothing, so the floor is 1.
  assert.equal(info.kilobytes, 1);
});

test('describes an unusable value without throwing', () => {
  const info = describeDataUrl(null);
  assert.equal(info.mime, '');
  assert.equal(info.ext, 'IMG');
  assert.equal(info.kilobytes, 1);
});

test('revoking is safe to call with junk and twice', () => {
  // Cleanup runs in an effect teardown, which can fire on an already-torn-down
  // component. It must never throw and take the unmount down with it.
  assert.doesNotThrow(() => revokeObjectUrl(''));
  assert.doesNotThrow(() => revokeObjectUrl(null));
  assert.doesNotThrow(() => revokeObjectUrl('not-a-url'));
  assert.doesNotThrow(() => revokeObjectUrl('blob:nothing'));
});
