// GOLDEN overlay — the correct fix: an hour is 3600 seconds. seed+golden PASSES the held-out oracle.
const UNIT_SECONDS = {
  s: 1,
  m: 60,
  h: 3600,
};

function parseDuration(text) {
  const match = String(text).trim().match(/^(\d+)([smh])$/);
  if (match === null) {
    throw new Error(`unparseable duration: ${text}`);
  }
  const value = Number(match[1]);
  const unit = match[2];
  return value * UNIT_SECONDS[unit];
}

module.exports = { parseDuration };
