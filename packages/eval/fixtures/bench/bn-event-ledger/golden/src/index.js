// GOLDEN overlay — the ledger composes the seams. The KEY decision: reads replay the latest snapshot's state with
// ONLY the events appended strictly AFTER that snapshot, each exactly once. `snapshotNow()` folds the full current
// state into a new baseline and remembers the event index at that point, so subsequent reads start from there and
// never re-fold the pre-snapshot events. seed+golden PASSES the snapshot-then-append-then-read probe.
const { replay } = require("./projection.js");
const { snapshot, restore } = require("./snapshot.js");

function createLedger() {
  const events = [];
  let baseline = null; // snapshot of state at `baselineIndex`
  let baselineIndex = 0; // number of events folded into `baseline`

  function currentState() {
    const initial = baseline ? restore(baseline) : { balances: {} };
    // Replay ONLY the events appended strictly after the baseline — each exactly once.
    return replay(initial, events.slice(baselineIndex));
  }

  return {
    append(event) {
      events.push(event);
    },
    balanceOf(account) {
      return currentState().balances[account] ?? 0;
    },
    snapshotNow() {
      baseline = snapshot(currentState());
      baselineIndex = events.length;
      return baseline;
    },
    eventCount() {
      return events.length;
    },
  };
}

module.exports = { createLedger };
