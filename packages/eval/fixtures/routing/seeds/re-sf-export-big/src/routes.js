'use strict';

// Two consumers of exportCsv — they disagree on how the document is delivered,
// which is the fork a memory-safe rewrite has to resolve.

const { exportCsv } = require('./export');

// (1) HTTP download: sends the export to the client over a streaming response.
// res implements the Node writable-stream contract (res.write / res.end).
async function handleDownload(source, res) {
  res.setHeader('Content-Type', 'text/csv');
  const csv = await exportCsv(source);
  res.write(csv);
  res.end();
}

// (2) Scheduled job: writes the same export to disk as one blob.
async function dumpToFile(source, fs, path) {
  const csv = await exportCsv(source);
  await fs.promises.writeFile(path, csv, 'utf8');
}

module.exports = { handleDownload, dumpToFile };
