// pageCount(total, perPage) — how many pages a list of `total` items needs at `perPage` per page.
//
// PLANTED BUG: it uses Math.floor, so a list that does not divide evenly drops its final partial page —
// pageCount(10, 3) returns 3 instead of 4. The fix is to round UP (Math.ceil). `paginate.js` consumes this, so
// the bug propagates into `isLast`. The seed is a working-but-wrong impl (it does not throw).
function pageCount(total, perPage) {
  if (total <= 0) return 0;
  return Math.floor(total / perPage); // BUG: should be Math.ceil.
}

module.exports = { pageCount };
