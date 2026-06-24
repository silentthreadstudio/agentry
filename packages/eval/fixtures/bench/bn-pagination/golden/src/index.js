// GOLDEN overlay — composes the store and the pure paginator. seed+golden PASSES the oracle.
const { paginate } = require("./page.js");

function listPage(store, opts) {
  return paginate(store.all(), opts);
}

module.exports = { listPage };
