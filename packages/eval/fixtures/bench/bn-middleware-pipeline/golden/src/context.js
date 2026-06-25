// GOLDEN overlay — the mutable context + the send helper. seed+golden PASSES the oracle.
function createContext(request) {
  return {
    request,
    response: { status: 200, body: null },
    state: {},
  };
}

function send(ctx, status, body) {
  ctx.response = { status, body };
}

module.exports = { createContext, send };
