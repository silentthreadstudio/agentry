// BROKEN overlay — the PLAUSIBLE-NAIVE solution: slice from the offset and always report `start + size` as the
// next cursor. Mid-list pages look perfect, but the LAST page hands back a cursor past the end (a client loops
// forever), and an empty / past-end input still returns a bogus non-null cursor. seed+broken FAILS the oracle on
// every boundary TRAP. The bug is the missing null-at-the-end logic, not an obvious stub.
function paginate(items, cursor, size) {
  const start = cursor == null ? 0 : cursor;
  const page = items.slice(start, start + size);
  return { page, nextCursor: start + size };
}

module.exports = { paginate };
