// BROKEN overlay — the PLAUSIBLE-NAIVE solution: a leading-edge guard. It fires fn IMMEDIATELY on the first call
// of a burst and then ignores calls until a cooldown timer clears the flag. Looks like a debounce and "runs fn",
// but it fires on the FIRST call (not the trailing edge), never uses the last args, and fires before the delay —
// so seed+broken FAILS the oracle's "does not fire before the delay" and "uses the latest arguments" traps.
function debounce(fn, ms) {
  let cooling = false;
  return function (...args) {
    if (cooling) return;
    cooling = true;
    fn.apply(this, args);
    setTimeout(() => {
      cooling = false;
    }, ms);
  };
}

module.exports = { debounce };
