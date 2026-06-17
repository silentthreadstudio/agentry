'use strict';

const crypto = require('crypto');

const USERS = [
  { id: 1, email: 'ada@example.com', passwordHash: hash('correct horse') },
];

function hash(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

async function findUserByEmail(email) {
  return USERS.find((u) => u.email === email) || null;
}

async function verifyPassword(password, passwordHash) {
  return hash(password) === passwordHash;
}

module.exports = { findUserByEmail, verifyPassword };
