// GOLDEN overlay — a quote-aware single-line CSV scanner. Tracks in-quote state, treats commas inside quotes as
// data, and collapses a doubled quote `""` to a literal `"`. seed+golden PASSES the held-out oracle.
function parseLine(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'; // escaped quote — consume both, emit one
          i++;
        } else {
          inQuotes = false; // closing quote
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields.map((f) => f.trim());
}

module.exports = { parseLine };
