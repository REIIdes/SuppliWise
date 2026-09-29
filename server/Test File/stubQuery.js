'use strict';

/**
 * A stub that behaves like a Mongoose query.
 *
 * THE BUG THIS EXISTS TO STOP
 * ---------------------------
 * Every auth test here stubs the model like this:
 *
 *     User.findOne = async () => ({ _id: '…', email: '…' });
 *
 * which worked until `/login` started projecting the fields it needs:
 *
 *     await User.findOne({ email }).select('-profilePicture -bannerPicture');
 *
 * A real Mongoose query is BOTH thenable and chainable, so `.select()`,
 * `.lean()` and `await` all work on it. A plain object is not chainable, so
 * every one of those tests went red with
 *
 *     [login] User.findOne(...).select is not a function
 *
 * …and because that error is thrown inside a try/catch that ends in
 * `authFailure`, the route answered 500. The tests were not testing a
 * regression; they were hitting a stub that had stopped being a faithful
 * double. Fourteen assertions across three files failed for this one reason.
 *
 * THE LESSON
 * ----------
 * A stub that returns a bare object is only faithful while the production code
 * under test happens to await it directly. The moment the route chains a
 * method onto the result — which is an optimisation, not a behaviour change —
 * the double silently stops matching. When a stub and the real thing disagree
 * about their SHAPE, the stub is the thing that is wrong.
 *
 * @param {object|(() => object|Promise<object>)} source A document, or a
 *   function returning one (so async factories and per-call variation work).
 * @returns {object} A thenable, chainable query stand-in.
 */
function stubQuery(source) {
  const resolve = () => Promise.resolve(typeof source === 'function' ? source() : source);
  const query = {
    _id: undefined,
    // Field selection is a no-op here: the stub document already only holds
    // what the test put on it, and excluding a field it never had is a no-op
    // in production too.
    select: () => query,
    // `.lean()` is what the routes use when they want a plain object rather
    // than a hydrated document. Yield the projection shape, not the document,
    // so a test that relies on `.lean()` still sees what it would in prod.
    lean: async () => {
      const doc = await resolve();
      return doc ? { ...doc } : null;
    },
    // Thenable, so `await User.findById(id)` and `await User.findOne(q)` work.
    then: (onFulfilled, onRejected) => resolve().then(onFulfilled, onRejected),
    catch: (onRejected) => resolve().catch(onRejected),
  };
  return query;
}

module.exports = { stubQuery };
