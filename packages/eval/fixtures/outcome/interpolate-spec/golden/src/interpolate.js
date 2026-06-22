// GOLDEN overlay — a single left-to-right pass that recognizes, in priority order: the escapes `{{` -> `{` and
// `}}` -> `}`, then a `{key}` placeholder. A placeholder is replaced only when the key is PRESENT in `values`
// (otherwise the literal `{key}` is kept). Because escapes are matched before placeholders, `{{name}}` becomes the
// literal `{name}` and is never interpolated. seed+golden PASSES the held-out oracle.
function interpolate(template, values) {
  return String(template).replace(/\{\{|\}\}|\{(\w+)\}/g, (match, key) => {
    if (match === "{{") return "{";
    if (match === "}}") return "}";
    if (Object.prototype.hasOwnProperty.call(values, key)) return String(values[key]);
    return match; // missing key -> leave the literal placeholder
  });
}

module.exports = { interpolate };
