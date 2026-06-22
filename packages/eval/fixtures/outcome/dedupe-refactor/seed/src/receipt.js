// receipt.js — renders a receipt line. Carries its OWN copy of formatMoney, which has DRIFTED: it forgot the
// comma thousands separators (so 123456 -> "$1234.56" instead of "$1,234.56"). The refactor must replace this
// with the shared canonical helper.
function formatMoney(cents) {
  const dollars = Math.trunc(cents / 100);
  const rem = Math.abs(cents % 100);
  return `$${dollars}.${String(rem).padStart(2, "0")}`; // DRIFT: no thousands separators
}

function renderReceipt(cents) {
  return `Paid ${formatMoney(cents)}`;
}

module.exports = { renderReceipt };
