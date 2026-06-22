// BROKEN overlay — validate applies defaults and checks types, but SKIPS the required-column presence check, so
// a row missing a required column is wrongly reported ok. seed+broken FAILS the oracle.
function defineSchema(columns) {
  return {
    validate(row) {
      const value = { ...row };
      const errors = [];

      for (const [name, spec] of Object.entries(columns)) {
        if (value[name] === undefined) {
          if (spec.default !== undefined) value[name] = spec.default;
          // BUG: no required-presence check — a missing required column is never flagged as an error.
          continue;
        }
        if (typeof value[name] !== spec.type) {
          errors.push(`column ${name} expected ${spec.type}, got ${typeof value[name]}`);
        }
      }

      return { ok: errors.length === 0, value, errors };
    },
  };
}

module.exports = { defineSchema };
