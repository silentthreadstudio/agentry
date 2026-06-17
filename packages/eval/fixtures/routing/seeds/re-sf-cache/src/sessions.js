'use strict';

const { redis } = require('./redis');

// Convention B: shared Redis cache with explicit invalidation. Used by the
// session store because logout must evict the entry for ALL web workers at
// once.
async function getSession(token) {
  const raw = await redis.get(`session:${token}`);
  return raw ? JSON.parse(raw) : null;
}

async function putSession(token, data, ttlSec) {
  await redis.set(`session:${token}`, JSON.stringify(data), 'EX', ttlSec);
}

async function dropSession(token) {
  await redis.del(`session:${token}`);
}

module.exports = { getSession, putSession, dropSession };
