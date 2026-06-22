// GOLDEN overlay — dedupe by CASE-FOLDED email, keeping the FIRST occurrence (the spec'd resolution).
// seed+golden PASSES the oracle.
function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

function dedupe(users) {
  const seen = new Set();
  const out = [];
  for (const user of users) {
    const key = normalizeEmail(user.email);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(user);
  }
  return out;
}

module.exports = { normalizeEmail, dedupe };
