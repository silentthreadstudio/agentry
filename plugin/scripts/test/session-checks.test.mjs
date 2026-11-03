// Tests for lib/lane/session-checks.mjs: the record of the repo session skills' outcomes, and the view of
// what each phase has recorded under the window rule (a phase reads the entries after the newest entry of the
// other phase; per skill the later line wins, never the later `at`).
// Run: node --test plugin/scripts/test/session-checks.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { checksView, read, record } from "../lib/lane/session-checks.mjs";

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "session-checks-"));
  dirs.push(dir);
  return dir;
};
const FILE = ".agentry/run/process/session-checks.jsonl";
const at = (n) => `2026-11-0${n}T10:00:00.000Z`;
const entry = (phase, skill, result, when, note) => ({
  phase,
  skill,
  result,
  ...(note && { note }),
  at: at(when),
});
// A repo root holding the named skills' SKILL.md files.
const repoWith = (...skills) => {
  const root = tmp();
  for (const s of skills) {
    mkdirSync(join(root, ".claude", "skills", s), { recursive: true });
    writeFileSync(join(root, ".claude", "skills", s, "SKILL.md"), "# s\n");
  }
  return root;
};
const spec = (start, close) => ({
  extensions: {
    ...(start && { start: { checks: start } }),
    ...(close && { close: { checks: close } }),
  },
});

test("read gives no entries for a missing file, and record makes the folder", () => {
  const root = tmp();
  assert.deepEqual([...read(root)], []);
  record(root, entry("start", "a", "pass", 1));
  assert.deepEqual([...read(root)], [entry("start", "a", "pass", 1)]);
});

test("a line that is not an entry is skipped and counted", () => {
  const root = tmp();
  mkdirSync(join(root, ".agentry/run/process"), { recursive: true });
  const good = JSON.stringify(entry("close", "a", "fail", 1, "red"));
  writeFileSync(
    join(root, FILE),
    [
      good,
      "not json",
      JSON.stringify({ phase: "merge", skill: "a", result: "pass", at: at(1) }),
      "",
    ].join("\n"),
  );
  const entries = read(root);
  assert.equal(entries.length, 1);
  assert.equal(entries.skipped, 2);
});

test("an entry after a torn last line starts on a new line", () => {
  const root = tmp();
  record(root, entry("start", "a", "pass", 1));
  writeFileSync(join(root, FILE), `${readFileSync(join(root, FILE), "utf8")}{"phase":"sta`);
  record(root, entry("start", "b", "fail", 1));
  const text = readFileSync(join(root, FILE), "utf8");
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(
    read(root).map((e) => e.skill),
    ["a", "b"],
  );
  assert.equal(read(root).skipped, 1);
});

test("checksView is null when neither phase names a check, and a phase with none names none", () => {
  assert.equal(checksView({}, [], tmp()), null);
  assert.equal(checksView(spec([], undefined), [], tmp()), null);
  const view = checksView(spec(["a"], undefined), [], repoWith("a"));
  assert.deepEqual(view.close, { named: [], recorded: [], pending: [], failed: [], missing: [] });
  assert.deepEqual(view.start, {
    named: ["a"],
    recorded: [],
    pending: ["a"],
    failed: [],
    missing: [],
  });
});

test("the view counts pass, fail, pending and a named skill with no SKILL.md", () => {
  const root = repoWith("a", "b");
  const entries = [entry("close", "a", "pass", 1), entry("close", "b", "fail", 1, "red")];
  const { close } = checksView(spec(undefined, ["a", "b", "c"]), entries, root);
  assert.deepEqual(close.recorded, [
    { skill: "a", result: "pass", at: at(1) },
    { skill: "b", result: "fail", note: "red", at: at(1) },
  ]);
  assert.deepEqual([close.pending, close.failed, close.missing], [["c"], ["b"], ["c"]]);
});

test("the window rule: a phase reads only what follows the other phase's newest entry", () => {
  const root = repoWith("a");
  const both = spec(["a"], ["a"]);
  const entries = [entry("close", "a", "fail", 1), entry("start", "a", "pass", 2)];
  const view = checksView(both, entries, root);
  assert.deepEqual(
    view.start.recorded.map((r) => r.result),
    ["pass"],
  );
  assert.deepEqual(view.close.recorded, [], "a start entry after it ends the close window");
  // Before any start check, the close window is the last session's close.
  const first = checksView(both, [entry("close", "a", "fail", 1)], root);
  assert.deepEqual(first.close.failed, ["a"]);
  assert.deepEqual(first.start.recorded, [], "the start window is what follows the close entry");
});

test("per skill the later line counts, whatever its time", () => {
  const root = repoWith("a");
  const entries = [entry("start", "a", "fail", 5), entry("start", "a", "pass", 1)];
  const { start } = checksView(spec(["a"]), entries, root);
  assert.deepEqual(
    start.recorded.map((r) => [r.result, r.at]),
    [["pass", at(1)]],
  );
  assert.deepEqual(start.failed, []);
});

test("an entry for a skill no longer named is not counted", () => {
  const root = repoWith("a");
  const { start } = checksView(spec(["a"]), [entry("start", "old", "fail", 1)], root);
  assert.deepEqual([start.recorded, start.failed, start.pending], [[], [], ["a"]]);
});
