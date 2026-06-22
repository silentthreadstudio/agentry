// BROKEN overlay — format-money.js: the shared canonical helper WAS extracted correctly...
function formatMoney(cents) {
  const dollars = Math.trunc(cents / 100);
  const rem = Math.abs(cents % 100);
  const withCommas = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${withCommas}.${String(rem).padStart(2, "0")}`;
}

module.exports = { formatMoney };
