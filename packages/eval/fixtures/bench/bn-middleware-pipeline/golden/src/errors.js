// GOLDEN overlay — map a thrown error to a response, honoring `.status`, defaulting to 500. seed+golden PASSES.
function errorResponse(err) {
  if (err && typeof err.status === "number") {
    return { status: err.status, body: err.message };
  }
  return { status: 500, body: "internal error" };
}

module.exports = { errorResponse };
