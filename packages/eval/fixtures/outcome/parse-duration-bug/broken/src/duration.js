// BROKEN overlay — a plausible-but-WRONG "fix". seed+broken FAILS the held-out oracle.
// The bug: it "fixes" hours by reaching for a round 3000 (off by 600) instead of 3600 — so "2h" yields 6000, not
// 7200. The hours assertions still FAIL, proving the oracle discriminates a near-miss fix from a correct one.
const UNIT_SECONDS = {
  s: 1,
  m: 60,
  h: 3000,
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
