// Tests for hooks/memory-prime.mjs — the memory priming hook.
// Dep-free (node builtins only), mirroring hooks/subagent-emit.test.mjs: drives the real script via
// piped stdin JSON against a temp project root holding a small fact store.
// Run: node --test hooks/memory-prime.test.mjs
//
// The behavior under test is the fix for a SILENT failure: agents were told "you are primed with
// recalled gotchas" while nothing primed them, so they never called the memory MCP. These assert that
// priming actually happens, that it is ranked rather than dumped, and that every gate (config, event,
// empty task, empty store) fails CLOSED — a hook that breaks a prompt is worse than no hook.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "memory-prime.mjs");
let root;

function fact(
  name,
  {
    body,
    provenance = [],
    confidence = 0.7,
    usefulness = 0,
    status = "active",
    type = "repo-fact",
  },
) {
  const front = [
    "---",
    `id: p:${name}`,
    `type: ${type}`,
    "scope: repo",
    `confidence: ${confidence}`,
    `usefulness: ${usefulness}`,
    `status: ${status}`,
    "tags:",
    "  - test",
    "provenance:",
    ...provenance.map((p) => `  - ${p}`),
    "---",
    "",
    body,
  ].join("\n");
  writeFileSync(join(root, ".agentry", "memory", "facts", `${name}.md`), front);
}

function run(input) {
  // HOME points at the temp root so the GLOBAL memory store (`~/.agentry/memory`) is empty too —
  // otherwise the developer's own facts leak in and "nothing matches" can never be asserted.
  const res = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, HOME: root },
  });
  assert.equal(
    res.status,
    0,
    "the hook must always exit 0 — it may never break a prompt or a launch",
  );
  return res.stdout.trim();
}

const context = (out) =>
  out.length === 0 ? "" : JSON.parse(out).hookSpecificOutput.additionalContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentry-prime-"));
  mkdirSync(join(root, ".agentry", "memory", "facts"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("UserPromptSubmit primes the conductor with a matching fact (the default config)", () => {
  fact("chokidar", {
    body: "A chokidar watcher cannot be the sole source of truth for a file created and deleted within one tick.",
  });
  fact("unrelated", {
    body: "Astro deployed under a sub-path base does not auto-prefix hand-written href attributes.",
  });

  const out = context(
    run({
      hook_event_name: "UserPromptSubmit",
      cwd: root,
      prompt: "the chokidar watcher misses a file",
    }),
  );
  assert.match(out, /chokidar watcher cannot be the sole source/);
  assert.doesNotMatch(out, /Astro/, "priming is RANKED — an unrelated fact must not ride along");
});

test("the injection names the fact id so the agent can cite it in used_memories", () => {
  fact("chokidar", { body: "A chokidar watcher cannot be the sole source of truth." });
  const out = context(
    run({ hook_event_name: "UserPromptSubmit", cwd: root, prompt: "chokidar watcher truth" }),
  );
  assert.match(out, /p:chokidar/);
  assert.match(out, /used_memories/);
});

test("a subagent is NOT primed under the default config (workers are opt-in)", () => {
  fact("chokidar", { body: "A chokidar watcher cannot be the sole source of truth." });
  const out = run({
    hook_event_name: "SubagentStart",
    cwd: root,
    agent_prompt: "fix the chokidar watcher",
  });
  assert.equal(out, "", "default is memory.prime=conductor — a worker gets nothing");
});

test("memory.prime=all primes a subagent from its brief", () => {
  writeFileSync(
    join(root, ".agentry", "config.json"),
    JSON.stringify({ memory: { prime: "all" } }),
  );
  fact("chokidar", { body: "A chokidar watcher cannot be the sole source of truth." });
  const out = context(
    run({ hook_event_name: "SubagentStart", cwd: root, agent_prompt: "fix the chokidar watcher" }),
  );
  assert.match(out, /chokidar watcher cannot be the sole source/);
});

test("memory.prime=off primes nobody", () => {
  writeFileSync(
    join(root, ".agentry", "config.json"),
    JSON.stringify({ memory: { prime: "off" } }),
  );
  fact("chokidar", { body: "A chokidar watcher cannot be the sole source of truth." });
  assert.equal(
    run({ hook_event_name: "UserPromptSubmit", cwd: root, prompt: "chokidar watcher" }),
    "",
  );
});

test("primeLimit caps how many facts ride along", () => {
  writeFileSync(
    join(root, ".agentry", "config.json"),
    JSON.stringify({ memory: { primeLimit: 2 } }),
  );
  for (let i = 0; i < 6; i++)
    fact(`watcher${i}`, { body: `Watcher note ${i}: the chokidar watcher and its truth.` });
  const out = context(
    run({ hook_event_name: "UserPromptSubmit", cwd: root, prompt: "chokidar watcher truth" }),
  );
  assert.equal(out.split("\n").filter((l) => l.startsWith("- [")).length, 2);
});

test("a superseded fact never reaches recall", () => {
  fact("old", { body: "The chokidar watcher used to be the truth.", status: "superseded" });
  assert.equal(
    run({ hook_event_name: "UserPromptSubmit", cwd: root, prompt: "chokidar watcher truth" }),
    "",
  );
});

test("nothing matching, an empty store, a trivial prompt, and a bogus event all stay silent", () => {
  assert.equal(
    run({ hook_event_name: "UserPromptSubmit", cwd: root, prompt: "something nobody wrote about" }),
    "",
  );
  assert.equal(run({ hook_event_name: "UserPromptSubmit", cwd: root, prompt: "" }), "");
  assert.equal(run({ hook_event_name: "PreToolUse", cwd: root, prompt: "chokidar" }), "");
});

test("a malformed config and an unparseable fact are survived, not fatal", () => {
  writeFileSync(join(root, ".agentry", "config.json"), "{ not json");
  writeFileSync(join(root, ".agentry", "memory", "facts", "broken.md"), "no frontmatter here");
  fact("chokidar", { body: "A chokidar watcher cannot be the sole source of truth." });
  assert.match(
    context(
      run({ hook_event_name: "UserPromptSubmit", cwd: root, prompt: "chokidar watcher truth" }),
    ),
    /chokidar watcher cannot be/,
  );
});

test("a path named in the brief outranks a merely wordy match", () => {
  fact("byPath", {
    body: "Keep the transport edge thin.",
    provenance: ["packages/workbench/server/src/transport/http.ts"],
  });
  fact("byWords", { body: "The transport edge is thin and the edge of the transport is thin." });
  const out = context(
    run({
      hook_event_name: "UserPromptSubmit",
      cwd: root,
      prompt: "change packages/workbench/server/src/transport/http.ts",
    }),
  );
  const first = out.split("\n").find((l) => l.startsWith("- ["));
  assert.match(first ?? "", /p:byPath/);
});
