// GOLDEN overlay — the correct fix: round UP so a partial final page is counted. seed+golden PASSES the oracle.
// (Only meta.js needed fixing; paginate.js and index.js were correct given a correct pageCount, so the overlay
// touches just this file — it is copied on top of the seed.)
function pageCount(total, perPage) {
  if (total <= 0) return 0;
  return Math.ceil(total / perPage);
}

module.exports = { pageCount };
