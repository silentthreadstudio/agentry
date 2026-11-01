// Tests for lib/config.mjs — the strict reader of config.json's `merge` and `lanes` blocks (plan R1b
// §2): the shared table through `checkConfig`, `readConfig`'s project → global order and defaults,
// errors naming the file and key, and `/agentry:config` documenting both keys with their defaults.
// Run: node --test plugin/scripts/test/config.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULTS, checkConfig, readConfig } from "../lib/config.mjs";
import * as md from "../lib/process/markdown.mjs";
import { CONFIG_CASES, configOf, pathOf } from "./key-cases.mjs";

const COMMAND = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "commands", "config.md");
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "agentry-config-"));
  temps.push(d);
  return d;
};
/** A project and a home dir, each with a config.json when one is given. */
function place({ project, home } = {}) {
  const root = dir();
  const homeDir = dir();
  for (const [base, value] of [
    [root, project],
    [homeDir, home],
  ]) {
    if (value === undefined) continue;
    mkdirSync(join(base, ".agentry"));
    const text = typeof value === "string" ? value : JSON.stringify(value);
    writeFileSync(join(base, ".agentry", "config.json"), text);
  }
  return { root, home: homeDir };
}

test("the shared table: every good case passes, every bad case names exactly its paths", () => {
  for (const c of CONFIG_CASES) {
    const paths = [...new Set(checkConfig(configOf(c)).map(pathOf))].sort();
    assert.deepEqual(paths, [...(c.bad ?? [])].sort(), c.name);
  }
});

test("an unknown top-level key is named, with the nearest known one when it is close", () => {
  assert.deepEqual(checkConfig({ marge: { push: "never" } }), [
    'marge is not a known key (did you mean "merge"?)',
  ]);
  assert.deepEqual(checkConfig({ lane: {} }), ['lane is not a known key (did you mean "lanes"?)']);
  const [far] = checkConfig({ telemetry: true });
  assert.match(far, /^telemetry is not a known key \(expected "workDir"/);
  assert.doesNotMatch(far, /did you mean/);
});

test("a misspelled block is an error, not the defaults", () => {
  const { root, home } = place({ project: { marge: { push: "never" } } });
  assert.match(readConfig(root, { home }).error, /marge is not a known key \(did you mean "merge"/);
});

test("no config file anywhere: the defaults, push ask and three writers", () => {
  const { root, home } = place();
  assert.deepEqual(readConfig(root, { home }), {
    merge: { push: "ask" },
    lanes: { maxWriters: 3 },
  });
  assert.deepEqual(DEFAULTS, { merge: { push: "ask" }, lanes: { maxWriters: 3 } });
});

test("each block comes from the first file that holds it: project, then global", () => {
  const { root, home } = place({
    project: { merge: { push: "never" } },
    home: { merge: { push: "auto" }, lanes: { maxWriters: 5 } },
  });
  assert.deepEqual(readConfig(root, { home }), {
    merge: { push: "never" },
    lanes: { maxWriters: 5 },
  });
  const empty = place({ project: { merge: {} }, home: { merge: { push: "auto" } } });
  assert.deepEqual(readConfig(empty.root, { home: empty.home }).merge, { push: "ask" });
});

test("a bad value is an error naming the file and the key, in either file, never a default", () => {
  const project = place({ project: { merge: { push: "yes" }, lanes: { maxWriters: 0 } } });
  const { error } = readConfig(project.root, { home: project.home });
  assert.match(
    error,
    /\.agentry\/config\.json: merge\.push should be one of "ask", "auto", "never"; lanes\.maxWriters should be a whole number above 0$/,
  );
  const global = place({ project: { merge: { push: "ask" } }, home: { lanes: { maxWrites: 2 } } });
  assert.match(
    readConfig(global.root, { home: global.home }).error,
    /lanes\.maxWrites is not a known key \(did you mean "maxWriters"\?\)/,
  );
  assert.ok(readConfig(global.root, { home: global.home }).error.startsWith(global.home));
});

test("a config file that is no JSON object is an error, not the defaults", () => {
  const broken = place({ project: "{ nope" });
  assert.match(
    readConfig(broken.root, { home: broken.home }).error,
    /config\.json: not valid JSON/,
  );
  const list = place({ home: "[1]" });
  assert.match(
    readConfig(list.root, { home: list.home }).error,
    /the config file should be an object/,
  );
});

test("/agentry:config documents merge.push and lanes.maxWriters with the reader's defaults", () => {
  const text = readFileSync(COMMAND, "utf8");
  const table = md.tables(text).find((t) => t.header.includes("Key"));
  const rows = Object.fromEntries(
    table.rows.map((r) => [md.plain(r.cells.Key), md.plain(r.cells.Default)]),
  );
  assert.equal(rows["merge.push"], DEFAULTS.merge.push);
  assert.equal(rows["lanes.maxWriters"], String(DEFAULTS.lanes.maxWriters));
});

test("readConfig carries the mode a file sets, and no mode key when none does (A29)", () => {
  const set = place({ project: { mode: "night", merge: { push: "never" } } });
  assert.equal(readConfig(set.root, { home: set.home }).mode, "night");
  const none = place({ project: { merge: { push: "never" } } });
  assert.ok(!("mode" in readConfig(none.root, { home: none.home })));
});
