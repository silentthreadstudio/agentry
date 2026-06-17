'use strict';

// CSV export for report rows.
//
// Today everything is buffered: fetchAll() pulls the entire result set into an
// array, then we build one big string and return it. That string is what blows
// up on large datasets.
//
// The exact CSV dialect below is load-bearing — consumers depend on it:
//   - header row is always emitted first, even for an empty result set
//   - fields are wrapped in double quotes ONLY when they contain a comma,
//     a quote, or a newline; embedded quotes are doubled ("" )
//   - rows are joined with "\r\n" and the output ends WITHOUT a trailing newline
// Whatever shape the export becomes, these have to hold exactly.

const COLUMNS = ['id', 'name', 'amount'];

function encodeField(value) {
  const s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function encodeRow(record) {
  return COLUMNS.map((col) => encodeField(record[col])).join(',');
}

// Returns the whole CSV document as a single string.
async function exportCsv(source) {
  const records = await source.fetchAll();
  const lines = [COLUMNS.join(',')];
  for (const record of records) {
    lines.push(encodeRow(record));
  }
  return lines.join('\r\n');
}

module.exports = { exportCsv, COLUMNS, encodeRow, encodeField };
