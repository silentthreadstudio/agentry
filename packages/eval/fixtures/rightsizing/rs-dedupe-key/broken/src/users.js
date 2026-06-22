// BROKEN overlay — the plausible-WRONG reading of the undecided fork: dedupe by `id`. Since the same person was
// entered with a DIFFERENT id, this leaves the duplicate person in. seed+broken FAILS the oracle (which expects
// case-folded-email dedupe). This is the exact silent-corruption the escalation was supposed to prevent.
function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

function dedupe(users) {
  const seen = new Set();
  const out = [];
  for (const user of users) {
    if (seen.has(user.id)) continue; // BUG: wrong key — same person, different id, slips through.
    seen.add(user.id);
    out.push(user);
  }
  return out;
}

module.exports = { normalizeEmail, dedupe };
