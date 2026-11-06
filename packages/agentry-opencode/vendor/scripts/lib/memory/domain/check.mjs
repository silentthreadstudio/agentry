// check — the small validator kit the fact and episode shapes are built from. It accepts what zod's
// `string`, `number().min().max()`, `boolean`, `enum`, `array`, `optional` and `default` accept, and
// reports a failure as zod does: the same issue objects, in the same key order, and an error message that
// is those issues as indented JSON. A record that fails is therefore described the same way it was when
// the schemas were zod's. Pure.
//
// A rule is `(value, path, issues) -> output`: it pushes an issue per problem and returns the value kept.
// object(shape) -> { parse(data) -> { ok: true, value } | { ok: false, message } }

const joinValues = (values) => values.map((v) => `'${v}'`).join(" | ");

/** zod's name for a value's type, as an invalid_type issue reports it as `received`. */
function parsedType(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isNaN(value) ? "nan" : "number";
  return typeof value;
}

const wrong = (issues, path, expected, value, order) => {
  const received = parsedType(value);
  const message =
    received === "undefined" ? "Required" : `Expected ${expected}, received ${received}`;
  issues.push(
    order === "enum"
      ? { expected, received, code: "invalid_type", path, message }
      : { code: "invalid_type", expected, received, path, message },
  );
};

export const string = (value, path, issues) => {
  if (typeof value === "string") return value;
  wrong(issues, path, "string", value);
  return undefined;
};

export const boolean = (value, path, issues) => {
  if (typeof value === "boolean") return value;
  wrong(issues, path, "boolean", value);
  return undefined;
};

/** A number, with an inclusive `min` and/or `max` (Infinity passes where the bound allows it). */
export const number =
  ({ min, max } = {}) =>
  (value, path, issues) => {
    if (typeof value !== "number" || Number.isNaN(value)) {
      wrong(issues, path, "number", value);
      return undefined;
    }
    if (min !== undefined && value < min)
      issues.push({
        code: "too_small",
        minimum: min,
        type: "number",
        inclusive: true,
        exact: false,
        message: `Number must be greater than or equal to ${min}`,
        path,
      });
    if (max !== undefined && value > max)
      issues.push({
        code: "too_big",
        maximum: max,
        type: "number",
        inclusive: true,
        exact: false,
        message: `Number must be less than or equal to ${max}`,
        path,
      });
    return value;
  };

export const oneOf = (options) => (value, path, issues) => {
  if (typeof value !== "string") {
    wrong(issues, path, joinValues(options), value, "enum");
    return undefined;
  }
  if (!options.includes(value))
    issues.push({
      received: value,
      code: "invalid_enum_value",
      options,
      path,
      message: `Invalid enum value. Expected ${joinValues(options)}, received '${value}'`,
    });
  return value;
};

export const arrayOf = (rule) => (value, path, issues) => {
  if (!Array.isArray(value)) {
    wrong(issues, path, "array", value);
    return undefined;
  }
  return value.map((item, i) => rule(item, [...path, i], issues));
};

/** `rule`, or nothing: only `undefined` is absent (null still fails the rule). */
export const optional = (rule) => (value, path, issues) =>
  value === undefined ? undefined : rule(value, path, issues);

/** `rule`, with `fallback` standing in for an absent (undefined) value. */
export const withDefault = (rule, fallback) => (value, path, issues) =>
  rule(value === undefined ? fallback : value, path, issues);

/** An object of `shape` (key -> rule): unknown keys are dropped, the output keys follow the shape. */
export const object = (shape) => ({
  parse(data) {
    const issues = [];
    const value = {};
    for (const [key, rule] of Object.entries(shape)) {
      const kept = rule(data[key], [key], issues);
      if (kept !== undefined) value[key] = kept;
    }
    return issues.length
      ? { ok: false, message: JSON.stringify(issues, null, 2) }
      : { ok: true, value };
  },
});
