// BROKEN overlay — `pageSlice` does NOT paginate: it returns every item regardless of the requested page, so the
// core feature is absent. paginate([1,2,3,4,5],2,1) yields items [1,2,3,4,5] (should be [1,2]) and page 3 yields
// all five (should be [5]). seed+broken FAILS the oracle's per-page slice assertions — the paginator never slices.
function pageSlice(items, perPage, page) {
  return items.slice(); // BUG: returns ALL items, ignoring perPage/page — no pagination happens.
}

module.exports = { pageSlice };
