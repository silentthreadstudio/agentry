// BROKEN overlay — the PLAUSIBLE-NAIVE solution: split on commas and trim. Handles every plain row perfectly,
// but treats a comma inside a quoted field as a separator and never strips/un-escapes quotes. seed+broken FAILS
// the oracle on the quoted-comma and escaped-quote TRAP cases. The bug is the missing quote-awareness.
function parseLine(line) {
  return line.split(",").map((f) => f.trim());
}

module.exports = { parseLine };
