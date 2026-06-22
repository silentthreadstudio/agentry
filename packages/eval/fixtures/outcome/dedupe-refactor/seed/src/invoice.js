// invoice.js — renders an invoice line. Carries its OWN copy of formatMoney (copy-pasted, see receipt.js/report.js).
// This copy happens to be the canonical one; the others have drifted. The refactor extracts ONE shared helper.
function formatMoney(cents) {
  const dollars = Math.trunc(cents / 100);
  const rem = Math.abs(cents % 100);
  const withCommas = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${withCommas}.${String(rem).padStart(2, "0")}`;
}

function renderInvoice(cents) {
  return `Invoice total: ${formatMoney(cents)}`;
}

module.exports = { renderInvoice };
