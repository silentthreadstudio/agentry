// An existing express middleware: a sibling to whatever records mutations for the audit log. It runs
// per request and attaches context. Audit logging middleware would live here and wrap mutating routes.

let counter = 0;

export function requestId() {
  return (req, _res, next) => {
    req.requestId = `req-${++counter}`;
    next();
  };
}
