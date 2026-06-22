// pageInfo(total, perPage, page) — { page, pageCount, isLast } for a paginated list.
//
// This is CORRECT given a correct pageCount: it reads the count from meta.js and derives isLast from it. Because
// the seed's pageCount under-counts (the planted bug), `isLast` fires one page too early. Fixing meta.js fixes
// this too — no change needed here.
const { pageCount } = require("./meta.js");

function pageInfo(total, perPage, page) {
  const count = pageCount(total, perPage);
  return { page, pageCount: count, isLast: page >= count };
}

module.exports = { pageInfo };
