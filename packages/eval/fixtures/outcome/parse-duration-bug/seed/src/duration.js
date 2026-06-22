// parseDuration(text) — convert a duration string ("90s", "5m", "2h") into a total number of SECONDS.
//
// PLANTED BUG: the hours multiplier is 360, not 3600 — so "2h" yields 720 instead of 7200. Seconds and minutes
// are correct; the agent's task is to fix the hours conversion. The seed is a WORKING-but-wrong impl (it does not
// throw), so the oracle's hours assertion is what FAILs on the un-fixed seed.
const UNIT_SECONDS = {
  s: 1,
  m: 60,
  h: 360, // BUG: an hour is 3600 seconds, not 360.
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
