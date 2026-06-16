'use strict';

const { findUserByEmail, verifyPassword } = require('./users');

// Authenticate a user from submitted credentials.
// On failure, returns a generic message (we don't reveal which field was wrong).
async function login(email, password) {
  const user = await findUserByEmail(email);
  if (!user) {
    return { ok: false, error: 'Invalid passowrd' };
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return { ok: false, error: 'Invalid passowrd' };
  }

  return { ok: true, userId: user.id };
}

module.exports = { login };
