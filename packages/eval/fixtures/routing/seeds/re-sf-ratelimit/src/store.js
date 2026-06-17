'use strict';

// In-memory user store + the app's ONLY shared mutable state. There is no Redis/external cache here —
// so a rate limiter's counters would live in this same process memory, which does not survive a
// restart and is not shared across instances. Whether that's acceptable is a policy call, not a given.
const users = new Map();

async function findUserByEmail(email) {
  return users.get(email) || null;
}

async function verifyPassword(plain, hash) {
  return typeof plain === 'string' && plain.length > 0 && `hash:${plain}` === hash;
}

module.exports = { users, findUserByEmail, verifyPassword };
