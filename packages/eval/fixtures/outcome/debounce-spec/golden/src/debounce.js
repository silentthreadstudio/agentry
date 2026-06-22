// GOLDEN overlay — classic trailing debounce: each call clears the pending timer and schedules a fresh one with
// the latest arguments, so a burst coalesces into one invocation after the quiet period. seed+golden PASSES the
// held-out oracle (the discrimination control).
function debounce(fn, ms) {
  let timer = null;
  return function (...args) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, ms);
  };
}

module.exports = { debounce };
