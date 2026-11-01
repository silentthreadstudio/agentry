// config — the strict reader for the harness keys the lanes act on in `.agentry/config.json`
// (plan R1b §2, §3.1): `merge.push`, `lanes.maxWriters` and `mode`. It mirrors those two blocks of core's
// `AgentryConfig` (`packages/core/src/config.ts`; the plugin ships no dependency): an unknown key,
// a wrong type or an out-of-range value is an error naming it, never read as a default, and a
// missing one is the default (`push: "ask"`, `maxWriters: 3`). An unknown top-level key is an error
// too: a misspelled block (`marge`) would otherwise be skipped and loosen the result to the defaults.
// The keys inside the other known blocks are other readers'.
//
// Files: `<root>/.agentry/config.json` (project), then `<home>/.agentry/config.json` (global). Each
// block comes from the first file that holds it, as the memory block does; every file that exists
// is checked, so a broken one is never skipped over.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULTS = Object.freeze({ merge: { push: "ask" }, lanes: { maxWriters: 3 } });
const PUSH = ["ask", "auto", "never"];
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// Each block's keys: [test, what the value should be].
const BLOCKS = {
  merge: {
    push: [(v) => PUSH.includes(v), `should be one of ${PUSH.map((p) => `"${p}"`).join(", ")}`],
  },
  lanes: { maxWriters: [(v) => Number.isInteger(v) && v > 0, "should be a whole number above 0"] },
};

// Every top-level key `AgentryConfig` (packages/core/src/config.ts) has; the parity test holds the
// two together.
const TOP_LEVEL = ["workDir", "mode", "evolution", "memory", "merge", "lanes"];

// Edit distance, for the "did you mean" of an unknown key.
function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

// `<path> is not a known key`, with the nearest known key when one is close.
function unknownKey(path, key, known) {
  const near = known.find((k) => distance(key.toLowerCase(), k.toLowerCase()) <= 2);
  const says = near
    ? `did you mean "${near}"?`
    : `expected ${known.map((k) => `"${k}"`).join(", ")}`;
  return `${path} is not a known key (${says})`;
}

/** The problems of a parsed config file, each `<path> <message>`: an unknown top-level key and the
 *  `merge` and `lanes` blocks. PURE. The keys inside the other known blocks are not judged here. */
export function checkConfig(value) {
  if (!isObject(value)) return ["the config file should be an object"];
  const problems = Object.keys(value)
    .filter((key) => !TOP_LEVEL.includes(key))
    .map((key) => unknownKey(key, key, TOP_LEVEL));
  if (Object.hasOwn(value, "mode") && (typeof value.mode !== "string" || value.mode === ""))
    problems.push("mode should be a non-empty string");
  for (const [block, keys] of Object.entries(BLOCKS)) {
    if (!Object.hasOwn(value, block)) continue;
    const given = value[block];
    if (!isObject(given)) {
      problems.push(`${block} should be an object`);
      continue;
    }
    for (const [key, v] of Object.entries(given)) {
      const known = Object.hasOwn(keys, key) ? keys[key] : null;
      if (!known) problems.push(unknownKey(`${block}.${key}`, key, Object.keys(keys)));
      else if (!known[0](v)) problems.push(`${block}.${key} ${known[1]}`);
    }
  }
  return problems;
}

// A config file's parsed value, null when it does not exist, or { error }.
function readFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return error.code === "ENOENT" ? null : { error: `${path}: cannot read (${error.code})` };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: `${path}: not valid JSON (${error.message})` };
  }
}

/** The effective `{ merge: { push }, lanes: { maxWriters }, mode? }` (`mode` only when a file sets one) for the repo at `root`, or `{ error }`
 *  naming the file and each bad key. `home` is where the global `.agentry/` lives. */
export function readConfig(root, { home = homedir() } = {}) {
  const found = [];
  for (const path of [
    join(root, ".agentry", "config.json"),
    join(home, ".agentry", "config.json"),
  ]) {
    const file = readFile(path);
    if (file === null) continue;
    if (file.error) return { error: file.error };
    const problems = checkConfig(file.value);
    if (problems.length) return { error: `${path}: ${problems.join("; ")}` };
    found.push(file.value);
  }
  const block = (name) => ({
    ...DEFAULTS[name],
    ...found.find((value) => Object.hasOwn(value, name))?.[name],
  });
  const mode = found.find((value) => Object.hasOwn(value, "mode"))?.mode;
  return { merge: block("merge"), lanes: block("lanes"), ...(mode !== undefined && { mode }) };
}
