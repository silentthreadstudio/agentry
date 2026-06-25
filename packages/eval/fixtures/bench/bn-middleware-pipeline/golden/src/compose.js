// GOLDEN overlay — PURE compose. `run(ctx)` invokes the first middleware with a `next` that drives the rest in order.
// A middleware that does NOT call `next()` short-circuits: the remaining middlewares never run (we only ever advance
// when `next` is called). `next()` is guarded so it can be called at most once per middleware. seed+golden PASSES.
function compose(middlewares) {
  return function run(ctx) {
    let index = -1;
    function dispatch(i) {
      if (i <= index) {
        throw new Error("next() called multiple times");
      }
      index = i;
      const mw = middlewares[i];
      if (!mw) return; // end of chain
      let nexted = false;
      mw(ctx, function next() {
        nexted = true;
        dispatch(i + 1);
      });
      // If the middleware never called next(), the chain stops here — downstream never runs.
      return nexted;
    }
    dispatch(0);
    return ctx;
  };
}

module.exports = { compose };
