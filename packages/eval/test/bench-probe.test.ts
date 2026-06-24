// Zero-API tests for the conduct-once → four-axis bench probe (the reshape plan §"probe.ts"). The probe is driven
// by an INJECTED FAKE RUNNER (overlays a chosen tree + writes the decision trail + the stream — NO `claude -p`) and
// a CANNED CONTENT-KEYED JUDGE (a BUG/poor/weak marker ⇒ low, else high — zero API), so the whole flow runs offline.
//
// It asserts the contract end-to-end over the `test/fixtures/bench-mini/` corpus:
//   - the CODE + DECISION controls PASS on the planted golden↔broken / gold↔poor (the meter proves itself first);
//   - the four axes compute from the matrix;
//   - a bugProne + done + oracle-FAIL record yields an escapedDefect (Axis D bites);
//   - an absent-decision-trail record yields NO decisionScore (Axis A's n excludes it);
//   - the verify-fire heuristic reads the stream;
//   - a non-discriminating judge ABORTS the batch with no numbers (the controls can't be flattered).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runBenchProbe } from "../src/bench/probe.ts";
import { seedSandbox } from "../src/io/sandbox.ts";
import type { Cell } from "../src/conduct/cell.ts";
import type { Invocation, RunResult, Runner, Sandbox } from "../src/io/port.ts";

// A NON-plugin test cell: the fake runner ignores the plugin, so this avoids `runCell`'s pluginDir requirement. Its
// identity promptWrap hands the raw fixture prompt straight through, which the fake runner keys on to route.
const TEST_CELL: Cell = { id: "test", loadsPlugin: false, promptWrap: (p) => p };

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "bench-mini");

// --- the canned content-keyed judge (zero API) -------------------------------------------------------------------
//
// The judge fn receives the assembled rubric PROMPT (which embeds BOTH the rubric text AND the subject under test)
// and returns raw JSON. It keys off markers in the SUBJECT region ONLY (the rubric prose itself contains words like
// "poor"/"weak", so keying off the whole prompt would collapse every score): a planted `BUG`/`poor`/`weak` subject
// scores LOW (every dim 0), else HIGH (every dim 2). A uniform per-dim score makes the engine normalize to overall 0
// or 1 for any rubric (4-dim or 5-dim), so the controls' discrimination (high gold, low broken/poor) holds for both.

/** Extract just the subject text the engine delimits, so a marker in the rubric prose can't skew the canned score. */
function subjectOf(prompt: string): string {
  const m = /=== SUBJECT UNDER TEST ===\n([\s\S]*?)\n\nReturn ONLY a JSON object/.exec(prompt);
  return m ? m[1]! : prompt;
}

function cannedJudge(prompt: string, _model: string): string {
  const subject = subjectOf(prompt);
  const low = /BUG:|\bpoor\b|\bweak\b|0\/0|NaN when/i.test(subject);
  const dim = low ? 0 : 2;
  // Cover both rubrics' dimension sets; the engine reads only the keys ITS rubric names, ignoring the rest.
  const dims = {
    meetsIntent: dim, correct: dim, soundCode: dim, complete: dim,
    forkSurfacing: dim, decisionSoundness: dim, accountability: dim, scope: dim, coherence: dim,
  };
  return JSON.stringify({ dimensions: dims, rationale: low ? "weak" : "strong" });
}

/** A judge that scores everything identically (overall always 1) — cannot separate gold from broken/poor. */
function flatJudge(_prompt: string, _model: string): string {
  const dim = 2;
  const dims = {
    meetsIntent: dim, correct: dim, soundCode: dim, complete: dim,
    forkSurfacing: dim, decisionSoundness: dim, accountability: dim, scope: dim, coherence: dim,
  };
  return JSON.stringify({ dimensions: dims, rationale: "flat" });
}

// --- the fake runner (zero API) ----------------------------------------------------------------------------------
//
// Per fixture id it (a) overlays a chosen tree into the already-seeded sandbox, (b) optionally writes a decision
// trail (`.agentry/work/<slug>/spec.md`), and (c) writes a `stream.jsonl` that self-reports done + (optionally)
// shows a verifier dispatch. It returns a settled `RunResult`. The probe never knows the runner is fake — same
// `Runner` port as live.

interface FakePlan {
  /** Absolute path to the tree overlaid into the sandbox (the "produced" result). */
  overlayDir: string;
  /** Write a decision trail (`spec.md`) so a decisionScore is produced; omit to leave NONE (Axis-A absent case). */
  writeTrail: boolean;
  /** The spec.md body (must be judged HIGH/LOW by the canned judge via its markers). */
  trailBody?: string;
  /** Whether the stream self-reports done. */
  done: boolean;
  /** Whether the stream shows a verifier dispatch (drives verifyFired). */
  verify: boolean;
}

function fakeRunner(plans: Record<string, FakePlan>): Runner {
  return {
    run(invocation: Invocation, sandbox: Sandbox): Promise<RunResult> {
      // The probe seeds the sandbox from `seed/` before calling the runner; the prompt carries the fixture text, so
      // we route by matching a fixture's prompt keyword. (The test corpus prompts are disjoint enough to key on.)
      const id = invocation.prompt.includes("average(xs)") ? "bm-bug" : "bm-clamp";
      const plan = plans[id]!;

      seedSandbox(sandbox.workingDir, plan.overlayDir);

      if (plan.writeTrail) {
        const slugDir = join(sandbox.workingDir, ".agentry", "work", id);
        mkdirSync(slugDir, { recursive: true });
        writeFileSync(join(slugDir, "spec.md"), plan.trailBody ?? "# spec\nA decision artifact.\n", "utf8");
      }

      const lines: string[] = [];
      if (plan.verify) {
        lines.push(
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "tool_use", name: "Task", input: { subagent_type: "agentry:verifier" } }] },
          }),
        );
      }
      if (plan.done) {
        lines.push(JSON.stringify({ type: "result", subtype: "success", is_error: false }));
      }
      writeFileSync(invocation.streamPath, lines.join("\n"), "utf8");

      return Promise.resolve({ streamPath: invocation.streamPath, producedTreeNonEmpty: true, resultSubtype: "success" });
    },
  };
}

/** A fresh temp out-path for the probe's artifact. */
function outPath(): string {
  return join(mkdtempSync(join(tmpdir(), "bench-probe-")), "bench.json");
}

const GOLD = (id: string) => join(FIXTURES, id, "golden");
const BROKEN = (id: string) => join(FIXTURES, id, "broken");

// A clearly-good decision trail (high markers) for the bm-clamp matrix cell.
const GOOD_TRAIL = "# Spec: clamp\n\n## Decisions surfaced\nBoundary semantics chosen; override hint given. Crisp scope.\n";

// --- the happy path: controls pass + the four axes compute --------------------------------------------------------

test("controls PASS and the four axes compute over the bench-mini matrix", async () => {
  // bm-clamp: golden overlay (judged HIGH), a decision trail (Axis A present), done, no oracle failure.
  // bm-bug:   BROKEN overlay (judged LOW + oracle FAILS), NO trail (Axis A absent), done ⇒ escaped defect.
  const runner = fakeRunner({
    "bm-clamp": { overlayDir: GOLD("bm-clamp"), writeTrail: true, trailBody: GOOD_TRAIL, done: true, verify: true },
    "bm-bug": { overlayDir: BROKEN("bm-bug"), writeTrail: false, done: true, verify: false },
  });

  const { artifact, records } = await runBenchProbe({
    fixturesDir: FIXTURES,
    runner,
    cell: TEST_CELL,
    judge: cannedJudge,
    outPath: outPath(),
  });

  assert.equal(artifact.condition, "scored", "controls must pass ⇒ a scored artifact");
  assert.equal(records.length, 2, "two fixtures × k=1");

  const axes = artifact.axes!;

  // Axis A: only bm-clamp carried a trail ⇒ n === 1, mean high (the canned judge scored the good trail 1.0).
  assert.equal(axes.decisionQuality.n, 1, "the no-trail bm-bug record is excluded from Axis A");
  assert.equal(axes.decisionQuality.mean, 1);

  // Axis B: both code trees judged; correctnessPassRate = 1 pass (clamp golden) / 2 with-oracle = 0.5.
  assert.equal(axes.codeQuality.n, 2);
  assert.equal(axes.correctnessPassRate, 0.5);

  // Axis C: bm-bug said done on BROKEN code (judged low + oracle failed) ⇒ one overclaim / 2 = 0.5.
  assert.equal(axes.overclaimRate, 0.5);

  // Axis D: bm-bug is the only bugProne record; done + oracle FAIL ⇒ escaped ⇒ rate 1/1.
  assert.equal(axes.escapedDefectRate, 1);
  // verify fired only on bm-clamp ⇒ 1/2.
  assert.equal(axes.verifyFireRate, 0.5);
});

test("the matrix record for the bugProne fixture carries escapedDefect, and the no-trail record has no decisionScore", async () => {
  const runner = fakeRunner({
    "bm-clamp": { overlayDir: GOLD("bm-clamp"), writeTrail: true, trailBody: GOOD_TRAIL, done: true, verify: false },
    "bm-bug": { overlayDir: BROKEN("bm-bug"), writeTrail: false, done: true, verify: false },
  });
  const { records } = await runBenchProbe({ fixturesDir: FIXTURES, runner, cell: TEST_CELL, judge: cannedJudge, outPath: outPath() });

  const bug = records.find((r) => r.fixtureId === "bm-bug")!;
  assert.equal(bug.escapedDefect, true);
  assert.equal(bug.oraclePass, false);
  assert.equal(bug.decisionScore, undefined, "bm-bug wrote no trail ⇒ no decisionScore");

  const clamp = records.find((r) => r.fixtureId === "bm-clamp")!;
  assert.notEqual(clamp.decisionScore, undefined, "bm-clamp wrote a trail ⇒ a decisionScore");
  assert.equal(clamp.oraclePass, true, "the clamp golden passes its oracle");
});

test("a single-fixture filter conducts only the matching fixture", async () => {
  const runner = fakeRunner({
    "bm-clamp": { overlayDir: GOLD("bm-clamp"), writeTrail: true, trailBody: GOOD_TRAIL, done: true, verify: false },
    "bm-bug": { overlayDir: BROKEN("bm-bug"), writeTrail: false, done: true, verify: false },
  });
  const { records } = await runBenchProbe({
    fixturesDir: FIXTURES,
    runner,
    cell: TEST_CELL,
    judge: cannedJudge,
    fixtureFilter: "bm-clamp",
    outPath: outPath(),
  });
  assert.equal(records.length, 1);
  assert.equal(records[0]!.fixtureId, "bm-clamp");
});

// --- the controls-abort path: a non-discriminating judge can't be flattered --------------------------------------

test("a flat (non-discriminating) judge ABORTS the batch with no axes/census", async () => {
  // The runner is irrelevant — the controls gate fires BEFORE any conduct. A flat judge scores golden and broken
  // identically, so the code control's discrimination fails and the batch aborts.
  const runner = fakeRunner({
    "bm-clamp": { overlayDir: GOLD("bm-clamp"), writeTrail: true, done: true, verify: false },
    "bm-bug": { overlayDir: BROKEN("bm-bug"), writeTrail: false, done: true, verify: false },
  });
  const { artifact, records } = await runBenchProbe({
    fixturesDir: FIXTURES,
    runner,
    cell: TEST_CELL,
    judge: flatJudge,
    outPath: outPath(),
  });
  assert.equal(artifact.condition, "aborted");
  assert.match(artifact.abortVerdict ?? "", /bench-code-judge-cannot-discriminate/);
  assert.equal(artifact.axes, undefined, "an aborted run emits NO numbers");
  assert.equal(artifact.census, undefined);
  assert.equal(records.length, 0, "no matrix ran");
});

test("the decision-control gate is SKIPPED (no abort) when the controls dir is absent", async () => {
  // Point the controls dir at a non-existent path: the code control still runs (per-fixture golden/broken), but the
  // decision control is skipped — so a content-keyed judge that discriminates code still yields a SCORED artifact.
  const runner = fakeRunner({
    "bm-clamp": { overlayDir: GOLD("bm-clamp"), writeTrail: true, trailBody: GOOD_TRAIL, done: true, verify: false },
    "bm-bug": { overlayDir: GOLD("bm-bug"), writeTrail: false, done: true, verify: false },
  });
  const { artifact } = await runBenchProbe({
    fixturesDir: FIXTURES,
    runner,
    cell: TEST_CELL,
    judge: cannedJudge,
    decisionControlsDir: join(tmpdir(), "no-such-controls-dir-xyz"),
    outPath: outPath(),
  });
  assert.equal(artifact.condition, "scored", "absent decision controls ⇒ skip the gate, still score");
});

// --- the probe writes its artifact to disk -----------------------------------------------------------------------

test("the probe writes the artifact to outPath", async () => {
  const runner = fakeRunner({
    "bm-clamp": { overlayDir: GOLD("bm-clamp"), writeTrail: true, trailBody: GOOD_TRAIL, done: true, verify: false },
    "bm-bug": { overlayDir: BROKEN("bm-bug"), writeTrail: false, done: true, verify: false },
  });
  const out = outPath();
  const { outPath: written } = await runBenchProbe({ fixturesDir: FIXTURES, runner, cell: TEST_CELL, judge: cannedJudge, outPath: out });
  assert.equal(written, out);
  assert.ok(existsSync(out), "the artifact JSON is on disk");
});
