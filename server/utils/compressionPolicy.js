/**
 * One compression policy, so the Server-Sent Events rule can be tested instead
 * of eyeballed inside index.js.
 *
 * WHY `text\/event-stream` IS REFUSED
 * -----------------------------------
 * `compression.filter()` asks mime-db whether a content type is compressible,
 * and mime-db lists `text/event-stream` as compressible — so the default answer
 * is yes. A deflated stream then buffers every `event:` line inside zlib until
 * enough of them arrive to fill a block: the connection stays open, the client's
 * `readyState` says CONNECTING, and nothing arrives. The symptom users report is
 * "the chat only updates when I reload", and because the buffering happens
 * inside Node, a correctly-unbuffered nginx in front of it cannot see or fix it.
 *
 * Events are also tiny, per-line, and already repetitive — gzip buys nothing
 * here and costs the one property the format exists to have.
 *
 * `x-no-compression` is kept from the previous inline policy: a client that is
 * asking for an uncompressed body (a proxy that cannot handle one) must be able
 * to say so.
 */
const compression = require('compression');

const COMPRESSION_LEVEL = 6;   // balanced between CPU and ratio
const COMPRESSION_THRESHOLD = 1024; // only bodies larger than 1 KB

function isEventStream(res) {
  return /^text\/event-stream/i.test(String(res.getHeader('content-type') || ''));
}

function filter(req, res) {
  if (req.headers['x-no-compression']) return false;
  if (isEventStream(res)) return false;
  return compression.filter(req, res);
}

function options() {
  return { level: COMPRESSION_LEVEL, threshold: COMPRESSION_THRESHOLD, filter };
}

module.exports = { options, filter, isEventStream, COMPRESSION_LEVEL, COMPRESSION_THRESHOLD };
