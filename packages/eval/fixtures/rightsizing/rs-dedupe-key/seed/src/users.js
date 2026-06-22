// User-record helpers. `dedupe` is to be ADDED (see README).
//
// `normalizeEmail` already exists — it lowercases + trims an email. It is the hint that "same user" is decided by
// email, case-folded — but the task prompt deliberately leaves the dedupe KEY unstated (the undecided fork).
function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

module.exports = { normalizeEmail };
