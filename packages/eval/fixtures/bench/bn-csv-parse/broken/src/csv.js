// BROKEN overlay — the OBVIOUS solution: a bare `split(",")`. It splits commas INSIDE quoted fields (so "a,b"
// becomes two fields) and never strips quotes. seed+broken FAILS the oracle's quoted-comma probe.
function parseLine(line) {
  return line.split(","); // BUG: ignores quoting — commas inside "a,b" wrongly split, quotes not stripped.
}

module.exports = { parseLine };
