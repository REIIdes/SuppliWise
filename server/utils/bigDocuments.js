/**
 * BIG-DOCUMENT READS — a second, deliberately slow-tolerant MongoDB connection.
 *
 * The main client in index.js is tuned for interactive work: `socketTimeoutMS`
 * is 5 s so a stalled socket fails a sign-in promptly instead of holding the
 * request for the full timeout. That is the right trade for the ~99% of
 * documents in this app, which are single-digit-millisecond reads.
 *
 * A few documents are not that. An admin account carries its profile picture
 * and background as base64 data URLs in the same document, and on this data set
 * a background is ~3 MB. Reading it back over Atlas is measured at roughly
 * 10 ms/KB — about 30 s for the 3 MB case. No amount of tuning makes a 30 s
 * read fit a 5 s socket budget, so that read could ONLY ever fail. It did,
 * repeatedly:
 *
 *   [admin/profile/pictures] connection 7 to <cluster>:27017 timed out
 *   [login]                  connection 9 to <cluster>:27017 timed out
 *
 * The second line is the part that mattered. Every failed picture read held a
 * socket for the full timeout while it waited, the pool is only `maxPoolSize:
 * 10`, and the admin console refetches pictures on mount — so a handful of
 * mounted consoles were enough to saturate the pool and take *sign-in* down
 * with it. The two symptoms have one cause.
 *
 * So those reads get their own connection, with a socket budget that matches
 * the size of the data, and their own tiny pool so they cannot starve the
 * interactive one no matter how many consoles mount at once.
 *
 * Deliberately NOT used for anything else. Queries here are still fully
 * parameterised and still go through the same cluster and the same auth.
 */
const { MongoClient } = require('mongodb');

// A 3 MB read at the measured 10 ms/KB is ~30 s. 60 s leaves headroom for a
// larger banner and for cluster latency, while still bounding the request: the
// HTTP layer's own `requestTimeout` is 60 s (index.js), so this can never
// outlive the request that asked for it.
const BULK_SOCKET_TIMEOUT_MS = 60_000;
// Two sockets is plenty: every caller shares one in-flight read (see the
// single-flight map below), so concurrency here is bounded by "how many distinct
// admin pictures are being read at once", not by request volume.
const BULK_POOL_SIZE = 2;

let clientPromise = null;
// Latched after a connect failure. Without it every request would retry a dead
// connection and pay the full `serverSelectionTimeoutMS` to fail, which is the
// same pool-starvation failure this file exists to prevent.
let unavailable = false;

function bulkClient() {
  if (unavailable) return null;
  if (clientPromise) return clientPromise;
  const uri = process.env.MONGO_URI;
  if (!uri) {
    unavailable = true;
    return null;
  }
  const client = new MongoClient(uri, {
    maxPoolSize: BULK_POOL_SIZE,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: BULK_SOCKET_TIMEOUT_MS,
    waitQueueTimeoutMS: 15000,
  });
  clientPromise = client.connect().catch((error) => {
    clientPromise = null;
    unavailable = true;
    try {
      console.error(`[bulk-read] secondary connection unavailable, big documents will be skipped: ${error.message}`);
    } catch { /* logging must not throw */ }
    return null;
  });
  return clientPromise;
}

/**
 * Single-flight: one in-flight read per document, shared by every caller.
 *
 * Without this, N consoles mounting at the same moment issue N identical 3 MB
 * reads. That is both slow and the direct cause of the pool saturation above.
 */
const inFlight = new Map();

/**
 * Read one document by id, tolerating the size of the document.
 *
 * @param {string} collection  Collection name.
 * @param {string|import('mongodb').ObjectId} id  Document id.
 * @param {object} [projection]  Fields to return, same shape as a Mongoose
 *                                `.select()` string parsed into an object.
 * @returns {Promise<object|null>} The document, or null if it does not exist
 *          or the read failed. A failure here is a missing picture, never a
 *          failed request — see the caller's contract.
 */
async function readBigDocument(collection, id, projection = undefined) {
  const key = `${collection}:${id}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const task = (async () => {
    const client = await bulkClient();
    if (!client) return null;
    const options = projection ? { projection } : {};
    // maxTimeMS is server-side execution budget. It does not cover transfer
    // time, which is the actual problem here, but it still bounds a pathological
    // query so it cannot occupy a bulk socket indefinitely.
    options.maxTimeMS = BULK_SOCKET_TIMEOUT_MS - 5000;
    return client.db().collection(collection).findOne({ _id: id }, options);
  })().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, task);
  return task;
}

/** Close the secondary connection. Called on shutdown. */
async function closeBulkConnection() {
  const pending = clientPromise;
  clientPromise = null;
  inFlight.clear();
  if (!pending) return;
  try {
    const client = await pending;
    if (client) await client.close();
  } catch { /* shutting down anyway */ }
}

module.exports = { readBigDocument, closeBulkConnection };
