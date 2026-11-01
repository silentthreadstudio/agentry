// Tests for lib/memory/recall.mjs — reading the memory file store, ranking facts against a task, and
// rendering the ones that earn a slot. HOME is pointed at an empty directory so the developer's own global store
// never leaks into the fixtures.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  memoryRoots,
  rankFacts,
  readFacts,
  readMemoryConfig,
  renderFacts,
} from "../lib/memory/recall.mjs";

let home;
let project;
let savedHome;
beforeEach(() => {
  savedHome = process.env.HOME;
  home = realpathSync(mkdtempSync(join(tmpdir(), "recall-home-")));
  project = realpathSync(mkdtempSync(join(tmpdir(), "recall-proj-")));
  process.env.HOME = home;
  mkdirSync(join(project, ".agentry", "memory", "facts"), { recursive: true });
});
afterEach(() => {
  process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function fact(name, { body, provenance = [], status = "active", confidence = 0.7, tags = [] }) {
  const lines = [
    "---",
    `id: p:${name}`,
    "type: gotcha",
    `confidence: ${confidence}`,
    "usefulness: 0",
  ];
  lines.push(`status: ${status}`, "tags:", ...tags.map((t) => `  - ${t}`));
  lines.push("provenance:", ...provenance.map((p) => `  - ${p}`), "---", body, "");
  writeFileSync(join(project, ".agentry", "memory", "facts", `${name}.md`), lines.join("\n"));
}

test("memoryRoots lists the project store first, then the global one", () => {
  const roots = memoryRoots(project);
  assert.deepEqual(
    roots.map((r) => r.label),
    ["project", "global"],
  );
  assert.equal(roots[1].dir, join(home, ".agentry", "memory"));
});

test("readFacts returns active facts and skips superseded, frontmatter-less and unreadable ones", () => {
  fact("live", { body: "The router resolves subcommands by file name." });
  fact("old", { body: "Stale advice.", status: "superseded" });
  writeFileSync(join(project, ".agentry", "memory", "facts", "broken.md"), "no frontmatter");
  const facts = readFacts(project);
  assert.deepEqual(
    facts.map((f) => f.id),
    ["p:live"],
  );
  assert.equal(facts[0].source, "project");
});

test("readFacts is empty when there is no store at all", () => {
  rmSync(join(project, ".agentry"), { recursive: true });
  assert.deepEqual(readFacts(project), []);
});

test("rankFacts puts a fact whose provenance names the task's file ahead of a merely wordy match", () => {
  fact("wordy", { body: "Gates fail when worktrees leave files, and gates log output somewhere." });
  fact("path", { body: "Never pipe the gate.", provenance: ["plugin/scripts/lib/lane/gate.mjs"] });
  fact("other", { body: "Unrelated note about colour tokens in the website." });
  const ranked = rankFacts(readFacts(project), "change gate.mjs so a gate leaves files", 5);
  assert.equal(ranked[0].id, "p:path");
  assert.equal(
    ranked.some((f) => f.id === "p:other"),
    false,
  );
});

test("rankFacts is silent when nothing clears the relevance floor, and respects the limit", () => {
  fact("a", { body: "Chokidar watcher notes for the workbench transport." });
  fact("b", { body: "Chokidar watcher debounce for the workbench transport." });
  const facts = readFacts(project);
  assert.deepEqual(rankFacts(facts, "something nobody wrote about", 5), []);
  assert.deepEqual(rankFacts(facts, "", 5), []);
  assert.deepEqual(rankFacts([], "chokidar", 5), []);
  assert.equal(rankFacts(facts, "chokidar watcher workbench transport", 1).length, 1);
});

test("renderFacts names each fact's id, truncates long bodies, and is empty for no facts", () => {
  assert.equal(renderFacts([], "Heading"), "");
  const out = renderFacts(
    [{ id: "p:x", type: "gotcha", body: `${"long ".repeat(200)}` }],
    "Recalled:",
  );
  assert.match(out, /^Recalled:\n- \[gotcha · p:x\] long /);
  assert.match(out, /…\n/);
  assert.match(out, /used_memories/);
});

test("readMemoryConfig: defaults, a project override, and a malformed file", () => {
  assert.deepEqual(readMemoryConfig(project), {
    prime: "conductor",
    primeLimit: 5,
    captureCorrections: false,
  });
  writeFileSync(
    join(project, ".agentry", "config.json"),
    JSON.stringify({ memory: { prime: "all" } }),
  );
  assert.equal(readMemoryConfig(project).prime, "all");
  assert.equal(readMemoryConfig(project).primeLimit, 5);
  writeFileSync(join(project, ".agentry", "config.json"), "{ nope");
  assert.equal(readMemoryConfig(project).prime, "conductor");
});

test("memoryRoots reads the global store under AGENTRY_GLOBAL_DIR, as the memory server does", () => {
  const base = join(home, "elsewhere");
  process.env.AGENTRY_GLOBAL_DIR = base;
  try {
    assert.equal(memoryRoots(project)[1].dir, join(base, ".agentry", "memory"));
  } finally {
    delete process.env.AGENTRY_GLOBAL_DIR;
  }
});
