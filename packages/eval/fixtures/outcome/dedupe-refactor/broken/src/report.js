// BROKEN overlay — the PLAUSIBLE-NAIVE refactor: the helper was extracted and invoice + receipt were rewired, but
// report.js was MISSED — it still uses its stale DRIFTED local copy (float divide, no thousands separators). So
// renderReport(123456) returns "Revenue: $1234.56" instead of the canonical "$1,234.56". The held-out oracle
// catches the one un-rewired caller (the inconsistency the dedupe was meant to remove). The bug is the missed
// caller, not an obvious stub.
function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`; // stale drifted copy, never rewired to the shared helper
}

function renderReport(cents) {
  return `Revenue: ${formatMoney(cents)}`;
}

module.exports = { renderReport };
