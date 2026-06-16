// Existing middleware: a sibling slot for cross-cutting request handling. A session middleware that
// reads a token, looks it up in the token store, and attaches req.user would live alongside this one
// and be applied to protected routes the same way.

export function requireFields(...fields) {
  return (req, res, next) => {
    for (const field of fields) {
      if (req.body?.[field] === undefined) {
        return res.status(400).json({ error: `missing field: ${field}` });
      }
    }
    next();
  };
}
