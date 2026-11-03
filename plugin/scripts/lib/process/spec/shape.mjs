// shape — the checker combinators and value checks the process file (`board.mjs`) and the workflow file
// (`workflow.mjs`) are both built from. No schema here. A checker is `(value, path, bad) => void`, where
// `bad(path, message)` records a problem. Every name a file supplies is looked up as an own property,
// never reaching a built-in such as `constructor`. PURE: never reads, never throws.
import { posix } from "node:path";

export const quote = (xs) => xs.map((x) => `"${x}"`).join(", ");
export const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const has = (obj, key) => isObject(obj) && Object.hasOwn(obj, key);
/** `obj[key]` when `obj` holds `key` itself: a name from a file or the board (`toString`,
 *  `constructor`) never reads a built-in. */
export const own = (obj, key) => (has(obj, key) ? obj[key] : undefined);
export const join = (at, key) => (at ? `${at}.${key}` : key);
export const entries = (v) => (isObject(v) ? Object.entries(v) : []);
const validRegex = (v) => {
  try {
    return typeof v === "string" && new RegExp(v) instanceof RegExp;
  } catch {
    return false;
  }
};

/** True when `path` (relative to `root`, itself relative to the repository) leaves the repository. */
export function escapesRoot(root, path) {
  if (posix.isAbsolute(root) || posix.isAbsolute(path)) return true;
  const full = posix.normalize(posix.join(root, path));
  return full === ".." || full.startsWith("../");
}

export const is = (test, message) => (v, at, bad) => test(v) || bad(at, message);
export const str = is((v) => typeof v === "string", "should be a string");
export const bool = is((v) => typeof v === "boolean", "should be true or false");
export const posInt = is((v) => Number.isInteger(v) && v > 0, "should be a whole number above 0");
export const regex = is(validRegex, "should be a valid regular expression");
export const oneOf = (...xs) => is((v) => xs.includes(v), `should be one of ${quote(xs)}`);
export const like = (re, hint) =>
  is((v) => typeof v === "string" && re.test(v), `should be ${hint}`);
export const list = (item) => (v, at, bad) =>
  Array.isArray(v) ? v.forEach((x, i) => item(x, `${at}[${i}]`, bad)) : bad(at, "should be a list");
// A map of names; `__proto__` is refused, as no reader could hold it as a plain name.
export const record = (item) => (v, at, bad) => {
  if (!isObject(v)) return bad(at, "should be an object");
  for (const [k, x] of Object.entries(v)) {
    if (k === "__proto__") bad(join(at, k), "is a reserved name");
    else item(x, join(at, k), bad);
  }
};
export const strOrList = (v, at, bad) => (Array.isArray(v) ? list(str) : str)(v, at, bad);
/** A shape's key names, without the `!` that marks a required one. */
export const namesOf = (keys) => Object.keys(keys).map((k) => k.replace(/!$/, ""));
// An object with known keys; a key written `name!` is required. `open` lets unknown keys through;
// `full` names a missing key by its own path (`gate.quick.only is required`), as the harness keys do.
// The checker carries its `keys`, so the format reference can be bound to them (format-doc test).
export const shape = (keys, { open = false, full = false } = {}) =>
  Object.assign(
    (v, at, bad) => {
      if (!isObject(v)) return bad(at, "should be an object");
      const names = namesOf(keys);
      for (const k of names)
        if (has(keys, `${k}!`) && !has(v, k))
          full ? bad(join(at, k), "is required") : bad(at, `is missing "${k}"`);
      for (const [k, x] of Object.entries(v)) {
        const check = own(keys, k) ?? own(keys, `${k}!`);
        if (check) check(x, join(at, k), bad);
        else if (!open) bad(join(at, k), `is not a known key (expected ${quote(names)})`);
      }
    },
    { keys },
  );
export const FULL = { full: true };
// The harness keys' values: a string is never empty, a list never empty, a path stays inside the
// repository (relative to its git root), so a typo refuses instead of quietly checking less.
export const text = is(
  (v) => typeof v === "string" && v.length > 0,
  "should be a non-empty string",
);
export const repoPath = (v, at, bad) =>
  typeof v === "string" && v.length > 0
    ? escapesRoot(".", v) && bad(at, `"${v}" leaves the repository`)
    : text(v, at, bad);
export const filled = (item) => (v, at, bad) =>
  Array.isArray(v) && v.length === 0 ? bad(at, "should not be empty") : list(item)(v, at, bad);
// A list without repeats; empty is allowed (`merge.checks: []` names no repo check, as format.md says).
export const distinct = (item) => (v, at, bad) => {
  list(item)(v, at, bad);
  if (Array.isArray(v))
    v.forEach((x, i) => v.indexOf(x) < i && bad(`${at}[${i}]`, `repeats ${JSON.stringify(x)}`));
};
// One of several shapes, picked by the key that tells them apart (`table` vs `files`).
export const variant = (shapes, hint) => (v, at, bad) => {
  const key = isObject(v) && Object.keys(shapes).find((k) => has(v, k));
  return key ? shapes[key](v, at, bad) : bad(at, `should be ${hint}`);
};
