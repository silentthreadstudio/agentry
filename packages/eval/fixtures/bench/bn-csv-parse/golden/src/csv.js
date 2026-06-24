// GOLDEN overlay — a small state machine that respects double quotes (commas inside are literal, `""` is an escaped
// quote) and preserves empty/trailing fields. seed+golden PASSES the oracle.
function parseLine(line) {
  const fields = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1; // consume the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  fields.push(field); // the final field (empty after a trailing comma is preserved)
  return fields;
}

module.exports = { parseLine };
