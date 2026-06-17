'use strict';

// Auth routes. The login handler is the target for rate limiting — it is currently UNthrottled,
// so credential-stuffing has no ceiling. Note the two existing middleware below are applied
// inconsistently across routes (see register()), and neither is a rate limiter yet.
const { requireJson } = require('../middleware/require-json');
const { auditLog } = require('../middleware/audit-log');
const { findUserByEmail, verifyPassword } = require('../store');

async function login(req, res) {
  const { email, password } = req.body || {};
  const user = await findUserByEmail(email);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  return res.status(200).json({ userId: user.id });
}

async function logout(req, res) {
  return res.status(204).end();
}

// register() shows the house pattern for attaching middleware to a route. requireJson is applied
// per-route inline; auditLog is applied the same way. A rate limiter would slot in here too —
// but what it keys on, its window, its threshold, and where counts live are all unspecified.
function register(router) {
  router.post('/login', requireJson, login);
  router.post('/logout', auditLog, logout);
}

module.exports = { login, logout, register };
