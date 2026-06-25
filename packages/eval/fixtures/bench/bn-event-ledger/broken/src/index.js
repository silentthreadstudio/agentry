// BROKEN overlay — the ledger snapshots, but reads replay the snapshot baseline against ALL events from the start,
// re-folding the events already captured in the snapshot. Every unit passes alone: events/reducer/projection/
// snapshot are correct, and balanceOf is right UNTIL a snapshot is taken. The bug only surfaces across the
// snapshot+projection seam — a snapshot-then-read double-counts the pre-snapshot events. seed+broken FAILS the
// oracle's snapshot-then-append-then-read probe.
const { replay } = require("./projection.js");
const { snapshot, restore } = require("./snapshot.js");

function createLedger() {
  const events = [];
  let baseline = null; // snapshot of state at the time snapshotNow() was called

  function currentState() {
    const initial = baseline ? restore(baseline) : { balances: {} };
    // BUG: replays ALL events on top of the snapshot baseline instead of only the events appended strictly AFTER
    // the snapshot — the pre-snapshot events get folded in twice (double-count).
    return replay(initial, events);
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
      return baseline;
    },
    eventCount() {
      return events.length;
    },
  };
}

module.exports = { createLedger };
