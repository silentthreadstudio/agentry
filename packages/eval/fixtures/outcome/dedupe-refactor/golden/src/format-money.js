// GOLDEN overlay — format-money.js: the ONE shared canonical money formatter the three modules now delegate to.
function formatMoney(cents) {
  const dollars = Math.trunc(cents / 100);
  const rem = Math.abs(cents % 100);
  const withCommas = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${withCommas}.${String(rem).padStart(2, "0")}`;
}

module.exports = { formatMoney };
