'use strict';

const { MAX_UPLOAD_MB } = require('./config');

function validateUploadSize(bytes) {
  const limit = MAX_UPLOAD_MB * 1024 * 1024;
  if (bytes > limit) {
    return { ok: false, reason: 'file_too_large' };
  }
  return { ok: true };
}

module.exports = { validateUploadSize };
