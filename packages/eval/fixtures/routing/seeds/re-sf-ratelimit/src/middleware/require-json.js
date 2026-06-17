'use strict';

// House middleware shape: (req, res, next) => void. New middleware should follow this signature
// so it composes with register() in the routes. A rate limiter would be written the same way.
function requireJson(req, res, next) {
  const type = (req.headers && req.headers['content-type']) || '';
  if (!type.includes('application/json')) {
    return res.status(415).json({ error: 'expected application/json' });
  }
  return next();
}

module.exports = { requireJson };
