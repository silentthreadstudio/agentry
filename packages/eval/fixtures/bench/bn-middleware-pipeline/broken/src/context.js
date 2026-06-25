// BROKEN overlay — context + send are correct (the bug lives in compose, at the ordering/short-circuit seam).
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
