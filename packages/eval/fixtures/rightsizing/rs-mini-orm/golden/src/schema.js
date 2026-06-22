// GOLDEN overlay — applies defaults for missing optional columns, then validates required-presence + type.
// seed+golden PASSES the oracle.
function defineSchema(columns) {
  return {
    validate(row) {
      const value = { ...row };
      const errors = [];

      for (const [name, spec] of Object.entries(columns)) {
        const present = value[name] !== undefined;
        if (!present) {
          if (spec.default !== undefined) {
            value[name] = spec.default;
          } else if (spec.required) {
            errors.push(`missing required column: ${name}`);
            continue;
          } else {
            continue; // optional, no default, absent — nothing to check
          }
        }
        if (value[name] !== undefined && typeof value[name] !== spec.type) {
          errors.push(`column ${name} expected ${spec.type}, got ${typeof value[name]}`);
        }
      }

      return { ok: errors.length === 0, value, errors };
    },
  };
}

module.exports = { defineSchema };
