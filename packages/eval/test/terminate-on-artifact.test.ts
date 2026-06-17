// Tests for the ARTIFACT-AWARE early-terminate seam (autopilot-design §3). ZERO API spend: the capture path is
// driven by a FAKE CHILD that stays running (no auto-close) while a synthetic work folder gains `spec.md` then
// `plan.md` at controlled times — modeling the conductor writing its routing artifacts mid-run. We assert WHEN
// the child is killed (the only thing artifact-aware mode changes), not how the shape is later computed.
//
// The fake child here differs from capture-stream's: `emit(lines)` tees stdout but does NOT close the process,
// so the run stays alive for the poll to fire. The real shape verdict is `extractShape`'s job AFTER the run
// (unchanged, not exercised here); this file only proves the kill timing: decompose kills at once, spec-only
// kills after the grace, a settling no-artifact run is never force-killed, and the hard ceiling is the fallback.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { spawnClaudeStreaming } from "../src/io/live.ts";
import type { CaptureOptions, SpawnFn, StreamChild } from "../src/io/live.ts";
import type { Sandbox } from "../src/io/port.ts";

/**
 * A fake `claude` child for the artifact-poll path: it stays RUNNING after `emit()` (unlike capture-stream's
 * auto-closing FakeChild) so the work-folder poll has time to fire. `kill()` records the call and emits `close`
 * (a real child closes after a kill, resolving the capture promise). `settle()` lets the process end on its
 * own with no kill — the one-shot/degenerate natural-close path.
 */
class RunningChild extends EventEmitter implements StreamChild {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killCount = 0;

  kill = (): boolean => {
    this.killCount += 1;
    queueMicrotask(() => this.emit("close", null));
    return true;
  };

  /** Tee one or more synthetic stdout lines without ending the process (it keeps running for the poll). */
  emitLines(lines: string[]): void {
    for (const l of lines) this.stdout.emit("data", l);
  }

  /** End the process on its own (no kill) — the natural close of a settling run. */
  settle(): void {
    queueMicrotask(() => this.emit("close", 0));
  }
}

const THINKING_LINE =
  JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "" }] } }) + "\n";
const AGENT_DISPATCH_LINE =
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name: "Agent", input: {} }] },
  }) + "\n";
const RESULT_SUCCESS_LINE = JSON.stringify({ type: "result", subtype: "success", is_error: false }) + "\n";

function freshSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "selfeval-artifact-"));
  return { workingDir: dir, globalRoot: dir, projectRoot: dir, env: {} };
}

/** The work folder for one slug under the sandbox: `<workingDir>/.agentry/work/<slug>/`. */
function workSlugDir(sandbox: Sandbox, slug = "case"): string {
  const dir = join(sandbox.workingDir, ".agentry", "work", slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a named artifact file into a work-folder slug, simulating the conductor producing it mid-run. */
function writeArtifact(sandbox: Sandbox, name: string, slug = "case"): void {
  writeFileSync(join(workSlugDir(sandbox, slug), name), `# ${name}\n`, "utf8");
}

/** A non-empty `tasks/` dir under a slug — the OTHER decompose signal (mirrors extract.ts). */
function writeTasksEntry(sandbox: Sandbox, slug = "case"): void {
  const tasksDir = join(workSlugDir(sandbox, slug), "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, "T-001.md"), "# T-001\n", "utf8");
}

// Fast timing so the suite runs in milliseconds: poll every 5ms, grace 40ms, ceiling 5s (far above both).
const FAST: CaptureOptions = { terminateOnArtifact: true, pollMs: 5, graceMs: 40, timeoutMs: 5_000 };
const streamFile = (sandbox: Sandbox): string => join(sandbox.workingDir, "stream.jsonl");

// --- decompose: plan.md present → killed promptly --------------------------------------------------------

test("artifact mode kills promptly when plan.md appears (decompose determined)", async () => {
  const sandbox = freshSandbox();
  const child = new RunningChild();
  const spawnFn: SpawnFn = () => child;

  const run = spawnClaudeStreaming([], sandbox, streamFile(sandbox), FAST, spawnFn);
  // The conductor dispatches a subagent (would kill in default mode — must NOT here) and keeps working...
  child.emitLines([THINKING_LINE, AGENT_DISPATCH_LINE]);
  // ...then writes a plan.md a tick later → the poll must see it and kill.
  setTimeout(() => writeArtifact(sandbox, "plan.md"), 10);
  await run;

  assert.equal(child.killCount, 1, "plan.md → decompose determined → child killed exactly once");
});

test("artifact mode kills when a non-empty tasks/ dir appears (the other decompose signal)", async () => {
  const sandbox = freshSandbox();
  const child = new RunningChild();
  const spawnFn: SpawnFn = () => child;

  const run = spawnClaudeStreaming([], sandbox, streamFile(sandbox), FAST, spawnFn);
  setTimeout(() => writeTasksEntry(sandbox), 10);
  await run;

  assert.equal(child.killCount, 1, "non-empty tasks/ → decompose determined → killed");
});

// --- spec-first: spec.md only, no plan/tasks within the grace → killed after the grace -------------------

test("artifact mode waits out the grace on spec.md-only, then kills (spec-first determined)", async () => {
  const sandbox = freshSandbox();
  const child = new RunningChild();
  const spawnFn: SpawnFn = () => child;

  const before = Date.now();
  const run = spawnClaudeStreaming([], sandbox, streamFile(sandbox), FAST, spawnFn);
  // Only a spec.md ever appears — the grace window must elapse before the kill (it is NOT decompose).
  setTimeout(() => writeArtifact(sandbox, "spec.md"), 10);
  await run;
  const elapsed = Date.now() - before;

  assert.equal(child.killCount, 1, "spec-only past the grace → killed once");
  assert.ok(elapsed >= 40, `kill must wait out the ~grace window, not fire immediately (elapsed=${elapsed}ms)`);
});

// --- decompose-within-grace: spec.md, then plan.md before the grace expires → killed on decompose --------

test("a plan.md arriving within the spec grace upgrades to decompose and kills at once", async () => {
  const sandbox = freshSandbox();
  const child = new RunningChild();
  const spawnFn: SpawnFn = () => child;

  const before = Date.now();
  const run = spawnClaudeStreaming([], sandbox, streamFile(sandbox), FAST, spawnFn);
  setTimeout(() => writeArtifact(sandbox, "spec.md"), 5); // opens the grace
  setTimeout(() => writeArtifact(sandbox, "plan.md"), 15); // arrives within it → decompose
  await run;
  const elapsed = Date.now() - before;

  assert.equal(child.killCount, 1, "decompose within the grace → killed");
  // It killed on the decompose poll (~15-20ms), NOT by waiting the full grace (~45ms from the spec sighting).
  assert.ok(elapsed < 45, `decompose-within-grace kills on plan.md, not on grace expiry (elapsed=${elapsed}ms)`);
});

// --- no artifact + child settles on its own → NOT force-killed (one-shot / degenerate natural close) -----

test("a no-artifact run that settles on its own is never force-killed (one-shot path)", async () => {
  const sandbox = freshSandbox();
  const child = new RunningChild();
  const spawnFn: SpawnFn = () => child;

  const run = spawnClaudeStreaming([], sandbox, streamFile(sandbox), FAST, spawnFn);
  // The work folder never gains an artifact; the child emits its settled result and closes on its own.
  child.emitLines([THINKING_LINE, RESULT_SUCCESS_LINE]);
  child.settle();
  const subtype = await run;

  assert.equal(child.killCount, 0, "no artifact + natural close → never force-killed");
  assert.equal(subtype, "success", "the settled result subtype is observed on the natural close");
});

// --- ignore events.jsonl: the primer hook's log is NOT a routing artifact → no kill ---------------------

test("an events.jsonl in the work folder is ignored (not a routing artifact) → no artifact-kill", async () => {
  const sandbox = freshSandbox();
  const child = new RunningChild();
  const spawnFn: SpawnFn = () => child;

  const run = spawnClaudeStreaming([], sandbox, streamFile(sandbox), FAST, spawnFn);
  // Only the primer hook's own events.jsonl appears (a known naming collision) — it must NOT trigger a kill.
  setTimeout(() => writeArtifact(sandbox, "events.jsonl"), 10);
  // Let the poll run a few times, then settle the child on its own to end the run.
  setTimeout(() => {
    child.emitLines([RESULT_SUCCESS_LINE]);
    child.settle();
  }, 40);
  const subtype = await run;

  assert.equal(child.killCount, 0, "events.jsonl is the hook's log, not a routing artifact → no force-kill");
  assert.equal(subtype, "success", "the run settled on its own (no artifact ever determined a shape)");
});

// --- hard-ceiling fallback: nothing ever determines a shape → killed at timeoutMs -----------------------

test("the hard ceiling fires when no artifact ever determines a shape and the child never closes", async () => {
  const sandbox = freshSandbox();
  const child = new RunningChild();
  const spawnFn: SpawnFn = () => child;

  // A tiny ceiling, no artifact ever written, child never settles → only the ceiling can end the run.
  const opts: CaptureOptions = { terminateOnArtifact: true, pollMs: 5, graceMs: 1_000, timeoutMs: 30 };
  const before = Date.now();
  const run = spawnClaudeStreaming([], sandbox, streamFile(sandbox), opts, spawnFn);
  child.emitLines([THINKING_LINE]); // it runs, but never writes an artifact and never closes
  await run;
  const elapsed = Date.now() - before;

  assert.equal(child.killCount, 1, "the hard ceiling is the fallback kill when nothing else terminates the run");
  assert.ok(elapsed >= 30, `ceiling must wait out timeoutMs (elapsed=${elapsed}ms)`);
});
