// GOLDEN overlay — a recursive deep clone of plain objects and arrays; nested values are cloned, not shared.
// seed+golden PASSES the held-out oracle (the discrimination control).
function deepClone(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((item) => deepClone(item));
  const out = {};
  for (const key of Object.keys(obj)) {
    out[key] = deepClone(obj[key]);
  }
  return out;
}

module.exports = { deepClone };
