'use strict';

// Second house middleware. Note it reaches for the client address via req.ip with a fallback to the
// X-Forwarded-For header — relevant because the app runs BEHIND a proxy, so req.ip alone is the proxy.
// Any per-client throttling has to decide which identity to trust here, and a per-IP limit behind a
// shared NAT/proxy can punish many users at once, while per-account invites lockout-as-DoS.
function auditLog(req, res, next) {
  const client = (req.headers && req.headers['x-forwarded-for']) || req.ip || 'unknown';
  // best-effort, non-blocking
  try {
    console.log(JSON.stringify({ at: Date.now(), path: req.path, client }));
  } catch (_) {}
  return next();
}

module.exports = { auditLog };
