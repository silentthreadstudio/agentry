'use strict';

const { validateUploadSize } = require('./upload');
const { REQUEST_TIMEOUT_MS } = require('./config');

function handleUpload(req) {
  const check = validateUploadSize(req.contentLength);
  if (!check.ok) {
    return { status: 413, body: check.reason };
  }
  return { status: 200, body: 'ok' };
}

module.exports = { handleUpload, REQUEST_TIMEOUT_MS };
