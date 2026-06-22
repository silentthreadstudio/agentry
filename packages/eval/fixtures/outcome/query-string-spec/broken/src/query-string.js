// BROKEN overlay — the PLAUSIBLE-NAIVE solution: split on `&`, split on `=`, assign straight into a plain object.
// Passes simple distinct-key cases but: a repeated key OVERWRITES (last write wins, no array), there is NO
// URL-decoding (`%20`, `%26`, `+` survive literally), and a bare key yields `undefined` rather than "".
// seed+broken FAILS the oracle on the repeat / empty / decode traps. The bug is the naive assignment, not a stub.
function parseQuery(qs) {
  const out = {};
  if (!qs) return out;
  for (const pair of qs.split("&")) {
    const [key, val] = pair.split("=");
    out[key] = val;
  }
  return out;
}

module.exports = { parseQuery };
