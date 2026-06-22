// GOLDEN overlay — split on `&`, then on the FIRST `=`; URL-decode key and value (with `+` -> space); collect
// repeated keys into an array in order; empty/missing value -> "". seed+golden PASSES the held-out oracle.
function decode(s) {
  return decodeURIComponent(s.replace(/\+/g, " "));
}

function parseQuery(qs) {
  const out = {};
  if (!qs) return out;
  for (const pair of qs.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawVal = eq === -1 ? "" : pair.slice(eq + 1);
    const key = decode(rawKey);
    const val = decode(rawVal);
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      if (Array.isArray(out[key])) out[key].push(val);
      else out[key] = [out[key], val];
    } else {
      out[key] = val;
    }
  }
  return out;
}

module.exports = { parseQuery };
