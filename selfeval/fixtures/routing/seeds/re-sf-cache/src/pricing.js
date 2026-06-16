'use strict';

const cache = require('./cache');
const { query } = require('./db');

// Uses Convention A (in-process TTL). Tiers almost never change, so a blunt
// 60s TTL with no invalidation is fine here.
async function getTier(tierId) {
  const key = `tier:${tierId}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const rows = await query('SELECT * FROM tiers WHERE id = ?', [tierId]);
  const tier = rows[0] || null;
  cache.set(key, tier, 60_000);
  return tier;
}

module.exports = { getTier };
