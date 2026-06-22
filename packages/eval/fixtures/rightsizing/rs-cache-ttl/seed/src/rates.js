// getRate(code, opts) — look up a rate. Today it fetches EVERY time (no cache) — the slow path to make faster.
//
// `opts` carries `fetch(code)` (the slow source), and — for the cached version — `ttlMs` and `now()`. The seed is
// correct but uncached; the undecided fork the task hides is the STALENESS policy (see README).
function getRate(code, opts) {
  return opts.fetch(code);
}

module.exports = { getRate };
