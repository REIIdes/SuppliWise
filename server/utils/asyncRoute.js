/**
 * Wrap an async request handler so a rejection becomes a response.
 *
 * Express 4 does not await a handler. When an `async` route rejects, nothing
 * answers the request: the promise dies in the microtask queue, the socket
 * stays open, and the client gives up at its own timeout. To the person using
 * the app that is indistinguishable from the API being down — which is exactly
 * how a one-line missing `try` in a sign-in path reads in an incident review.
 *
 * This forwards the rejection to Express's error chain instead, which lands in
 * the global handler in index.js: a logged server fault and a generic answer,
 * delivered while the request is still alive.
 *
 * Handlers that already catch their own failures are unaffected — this only
 * fires for what they miss. It is deliberately not applied blanket-wide: a
 * route that returns a considered 4xx/5xx for a specific fault should keep
 * doing that, and wrapping everything hides the sites that need thinking
 * about. Each use here is a handler where the bare awaits were read and the
 * flow is one a hanging request would make look like an outage.
 */
function asyncRoute(handler) {
  return function wrappedAsyncRoute(req, res, next) {
    let result;
    try {
      result = handler(req, res, next);
    } catch (error) {
      // A synchronous throw is already caught by Express; pass it along
      // untouched rather than double-handling it.
      return next(error);
    }
    if (result && typeof result.then === 'function') {
      return result.then(undefined, (error) => {
        // A handler that has already written its response cannot write another.
        // Logging is the honest outcome here; the client already has its answer.
        if (res.headersSent) {
          console.error('[asyncRoute] rejected after the response was sent:', error && error.message);
          return;
        }
        next(error);
      });
    }
    return result;
  };
}

module.exports = { asyncRoute };
