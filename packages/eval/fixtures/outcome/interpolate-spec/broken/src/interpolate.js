// BROKEN overlay — the PLAUSIBLE-NAIVE solution: one global replace of `{key}` with `values[key]`, no presence
// check and no escape handling. For a present key it works, but a MISSING key yields `values[key] === undefined`,
// so the output literally contains "undefined"; and `{{name}}` is treated as `{` + placeholder `{name}` + `}`,
// mangling the escape. seed+broken FAILS the oracle on the missing-key and escape traps. The bug is the naive
// replace, not an obvious stub.
function interpolate(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => values[key]);
}

module.exports = { interpolate };
