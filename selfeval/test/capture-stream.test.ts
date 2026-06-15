// Tests for the ported stream-capture + early-terminate seam (ADR-002/005). ZERO API spend: the streaming
// branch is driven by a FAKE CHILD emitting a synthetic NDJSON stream (no `claude -p` ever runs). This proves
// the line-tee + kill-after-dispatch logic; the LIVE reliability of `proc.kill()` leaving a well-formed
// partial `stream.jsonl` is a separate live probe (R1) — out of scope here.
//
// PORT of benchmark/test/capture-stream.test.ts: imports retargeted to ../src/io/*; assertions retyped from
// the dropped `RunRecord.eventsPath` to the minimal `RunResult.streamPath`; the two `buildArgs` cases reworked
// for UNCONDITIONAL stream-json (selfeval has no `--output-format json` / `captureStream` opt-in).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildArgs, runCaptured } from "../src/io/live.ts";
import type { SpawnFn, StreamChild } from "../src/io/live.ts";
import type { Invocation, Sandbox } from "../src/io/port.ts";

/**
 * A fake `claude` child: an EventEmitter with `stdout`/`stderr` streams and a `kill()` that records the call
 * and emits `close`. `feed(chunks)` pushes synthetic stdout, then (unless already killed) closes the process
 * — modeling a real spawn where stdout arrives, is consumed, and the process ends.
 */
class FakeChild extends EventEmitter implements StreamChild {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killCount = 0;

  // Match the `kill` signature loosely enough to satisfy StreamChild; we only need it to be callable.
  kill = (): boolean => {
    this.killCount += 1;
    // A real child closes after a kill; model that so the capture promise resolves.
    queueMicrotask(() => this.emit("close", null));
    return true;
  };

  feed(chunks: string[]): void {
    for (const c of chunks) this.stdout.emit("data", c);
    // Natural end-of-process if no dispatch killed us first.
    if (this.killCount === 0) queueMicrotask(() => this.emit("close", 0));
  }
}

/** An `assistant` event carrying a `tool_use name:"Agent"` block — the dispatch trigger (stream-json shape). */
const AGENT_DISPATCH_LINE =
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_1", name: "Agent", input: { subagent_type: "echoer" } }] },
  }) + "\n";

/** A benign `assistant` event with no tool_use — must NOT trigger a kill. */
const THINKING_LINE =
  JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "" }] } }) + "\n";

/** A system line that appears after dispatch — should never be reached once we kill on the Agent block. */
const SYSTEM_LINE =
  JSON.stringify({ type: "system", subtype: "task_started", task_id: "x" }) + "\n";

/** The settled-run `result` envelope — present on a no-dispatch run; its subtype surfaces on RunResult. */
const RESULT_SUCCESS_LINE =
  JSON.stringify({ type: "result", subtype: "success", is_error: false }) + "\n";

function freshSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "selfeval-capture-"));
  return { workingDir: dir, globalRoot: dir, projectRoot: dir, env: {} };
}

function streamFileIn(sandbox: Sandbox): string {
  return join(sandbox.workingDir, "stream.jsonl");
}

// --- (a)+(b)+(c): the streaming branch tees, kills on dispatch, and sets streamPath -------------------

test("captured run tees every emitted line to streamPath, kills on first Agent dispatch, sets RunResult.streamPath", async () => {
  const sandbox = freshSandbox();
  const streamPath = streamFileIn(sandbox);
  const child = new FakeChild();
  const spawnFn: SpawnFn = () => child;

  const inv: Invocation = { prompt: "noop", model: "test-model", streamPath };

  const runPromise = runCaptured(inv, sandbox, spawnFn);
  // Drive the synthetic stream: a benign line, then the dispatch (kills once); a trailing system line models
  // bytes already in flight at kill time — it must not trigger a SECOND kill (the killed-guard holds).
  child.feed([THINKING_LINE, AGENT_DISPATCH_LINE, SYSTEM_LINE]);
  const record = await runPromise;

  const written = readFileSync(streamPath, "utf8");
  // (a) lines are written to streamPath — the tee captured what the child emitted.
  assert.ok(written.includes('"thinking"'), "benign line should be teed to the stream file");
  assert.ok(written.includes('"name":"Agent"'), "the Agent dispatch line should be teed to the stream file");
  // (b) proc.kill() invoked exactly once, on the first Agent tool_use.
  assert.equal(child.killCount, 1, "kill() must fire exactly once, on the first Agent dispatch");
  // (c) the RunResult carries streamPath = the captured stream; a killed run has no settled result subtype.
  assert.equal(record.streamPath, streamPath);
  assert.equal(record.resultSubtype, undefined, "a killed run forfeits the trailing result envelope");
});

// --- no-dispatch run lets the process close normally (no kill) and observes its result subtype --------

test("a no-dispatch captured run is never killed, closes with streamPath set, and surfaces resultSubtype", async () => {
  const sandbox = freshSandbox();
  const streamPath = streamFileIn(sandbox);
  const child = new FakeChild();
  const spawnFn: SpawnFn = () => child;

  const inv: Invocation = { prompt: "noop", model: "test-model", streamPath };

  const runPromise = runCaptured(inv, sandbox, spawnFn);
  // No Agent block anywhere → the process closes on its own, emitting its settled `result` envelope.
  child.feed([THINKING_LINE, RESULT_SUCCESS_LINE]);
  const record = await runPromise;

  assert.equal(child.killCount, 0, "a no-dispatch run must close normally, never killed");
  assert.equal(record.streamPath, streamPath);
  assert.equal(record.resultSubtype, "success", "a settled run surfaces result.subtype");
  assert.ok(readFileSync(streamPath, "utf8").includes('"thinking"'));
});

// --- dispatch split across stdout chunks is still detected (line-buffering across reads) --------------

test("an Agent dispatch split across two stdout chunks is detected once the line completes", async () => {
  const sandbox = freshSandbox();
  const streamPath = streamFileIn(sandbox);
  const child = new FakeChild();
  const spawnFn: SpawnFn = () => child;

  const inv: Invocation = { prompt: "noop", model: "test-model", streamPath };
  const half = AGENT_DISPATCH_LINE.length >> 1;

  const runPromise = runCaptured(inv, sandbox, spawnFn);
  // Split the dispatch line mid-token across two data events; only the completed line should trigger.
  child.feed([AGENT_DISPATCH_LINE.slice(0, half), AGENT_DISPATCH_LINE.slice(half)]);
  const record = await runPromise;

  assert.equal(child.killCount, 1, "the dispatch must be detected once the buffered line is complete");
  assert.equal(record.streamPath, streamPath);
});

// --- buildArgs is UNCONDITIONAL stream-json (capture is selfeval's only mode) -------------------------

test("buildArgs always emits --output-format stream-json --verbose and never the json scoring format", () => {
  const argv = buildArgs({ prompt: "p", model: "m", streamPath: "/tmp/stream.jsonl" });
  const fmt = argv[argv.indexOf("--output-format") + 1];
  assert.equal(fmt, "stream-json");
  assert.ok(argv.includes("--verbose"), "capture argv must pass --verbose");
  // The single-result `json` scoring format must never appear as the output format.
  assert.notEqual(fmt, "json");
});

test("buildArgs passes through pluginDir, permissionMode, and allowedTools when set", () => {
  const argv = buildArgs({
    prompt: "p",
    model: "m",
    streamPath: "/tmp/stream.jsonl",
    pluginDir: "/repo",
    permissionMode: "bypassPermissions",
    allowedTools: ["Task", "Read"],
  });
  assert.equal(argv[argv.indexOf("--plugin-dir") + 1], "/repo");
  assert.equal(argv[argv.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(argv[argv.indexOf("--allowedTools") + 1], "Task,Read");
});

// --- a captured run without a streamPath is a usage error, not a silent no-op -------------------------

test("runCaptured rejects when no streamPath is provided", async () => {
  const sandbox = freshSandbox();
  // `streamPath` is required by the type; cast to exercise the runtime guard against a malformed caller.
  const bad = { prompt: "p", model: "m" } as unknown as Invocation;
  await assert.rejects(() => runCaptured(bad, sandbox, () => new FakeChild()), /streamPath/);
});
