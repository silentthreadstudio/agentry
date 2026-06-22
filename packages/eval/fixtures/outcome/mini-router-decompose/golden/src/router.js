// GOLDEN overlay — router.js: register routes, resolve with static-beats-dynamic precedence, first-registered
// wins among equals, trailing slash ignored (handled in match.js), 404 sentinel on no match.
const { matches } = require("./match.js");
const { extractParams } = require("./params.js");

function isStatic(pattern) {
  return !pattern.split("/").some((seg) => seg.startsWith(":"));
}

function createRouter() {
  const routes = []; // { pattern, handler, static, order }

  function register(pattern, handler) {
    routes.push({ pattern, handler, static: isStatic(pattern), order: routes.length });
  }

  function resolve(path) {
    const hits = routes.filter((r) => matches(r.pattern, path));
    if (hits.length === 0) return { status: 404 };
    // Static beats dynamic; among equals, the first registered (lowest order) wins.
    hits.sort((a, b) => {
      if (a.static !== b.static) return a.static ? -1 : 1;
      return a.order - b.order;
    });
    const best = hits[0];
    return { handler: best.handler, params: extractParams(best.pattern, path) };
  }

  return { register, resolve };
}

module.exports = { createRouter };
