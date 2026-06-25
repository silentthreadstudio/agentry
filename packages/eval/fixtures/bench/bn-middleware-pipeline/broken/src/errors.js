// BROKEN overlay — errors are correct (the bug lives in compose, at the ordering/short-circuit seam).
function errorResponse(err) {
  if (err && typeof err.status === "number") {
    return { status: err.status, body: err.message };
  }
  return { status: 500, body: "internal error" };
}

module.exports = { errorResponse };
