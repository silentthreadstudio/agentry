// Determinism-under-concurrency test for the moat probe's orchestration (the serial-loop → flattened-mapPool
// rework). The probe FLATTENS every (task × repeat) into its relevant + decoy conducts, pre-assigns a unique id-seed
// to each, drives them through `mapPool(concurrency)`, then REASSEMBLES per-(task,repeat) outcomes in task-major /
// repeat order. The contract: the scored numbers are IDENTICAL at any concurrency — only the orchestration changed.
//
// ZERO API by construction: an INJECTED fake runner (overlays a canned tree + writes a synthetic stream, no
// `claude -p`) and an INJECTED canned judge (no `claude -p`). The runner is also deliberately STAGGERED so that under
// concurrency > 1 the conducts finish OUT OF ORDER — the strongest test that `mapPool`'s index-preservation + the
// deterministic reassembly hold (a naive push-as-they-finish would scramble the outcomes and the numbers).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { runMoatProbe } from "../src/moat/probe.ts";
import type { MoatProbeOptions } from "../src/moat/probe.ts";
import type { RunResult, Runner } from "../src/io/port.ts";
import type { JudgeFn } from "../src/judge/index.ts";

// A distinctive marker the RELEVANT fact carries (and the decoy does not), plus the surfaced signature the fixture
// pins. The fake runner reads the seeded fact file to tell the two arms apart deterministically — exactly the on-disk
// seed the real conductor would recall.
const RELEVANT_MARKER = "dedupe by case-folded email";
const FACT_SIGNATURE = "case-folded email";

/** Two-task moat fixture (cold floor spec-first), authored on disk so the loader validates it like a real corpus. */
const TASKS_YAML = `
tasks:
  - id: task-alpha
    prompt: "Add dedupe to the import path."
    cold_floor: spec-first
    fact_signature: "${FACT_SIGNATURE}"
    relevant:
      type: decision
      scope: repo
      text: "Prior decision: ${RELEVANT_MARKER}; the fork is already settled."
    decoy:
      type: gotcha
      scope: repo
      text: "Unrelated: the build cache lives under tmp."
  - id: task-beta
    prompt: "Add dedupe to the export path."
    cold_floor: spec-first
    fact_signature: "${FACT_SIGNATURE}"
    relevant:
      type: decision
      scope: repo
      text: "Prior decision: ${RELEVANT_MARKER}; the fork is already settled."
    decoy:
      type: gotcha
      scope: repo
      text: "Unrelated: logs rotate weekly."
`;

/** Write the temp fixture dir (tasks.yaml; no seeds/ — optional) and return its path. */
function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "moat-conc-fixture-"));
  writeFileSync(join(dir, "tasks.yaml"), TASKS_YAML, "utf8");
  return dir;
}

/** The real package thresholds.json path (delta=null ⇒ no pass computed ⇒ stable, API-free). */
const THRESHOLDS = join(dirname(fileURLToPath(import.meta.url)), "..", "thresholds.json");

/**
 * A STAGGERED fake runner. It reads the seeded fact in the sandbox to tell the arms apart, then:
 *   - RELEVANT (fact carries the marker) ⇒ a clean one-shot: a non-empty produced tree + `resultSubtype: success`
 *     and NO `.agentry/work/` artifact ⇒ `extractShape` reads `one-shot` (lighter than the spec-first floor). Its
 *     stream surfaces the fact signature so `factSurfaced` ties the landing to it.
 *   - DECOY ⇒ a spec-first run: a `spec.md` under `.agentry/work/` ⇒ `extractShape` reads `spec-first` (held at the
 *     floor). Its stream lands a non-empty recall (no signature needed for the decoy).
 * Both streams carry a `memory_recall` tool_use + non-empty text so `recallLanded` is true.
 *
 * The stagger: each call resolves after a delay that DECREASES with the call ordinal, so later-launched conducts
 * finish before earlier ones under concurrency > 1 — forcing out-of-order completion. It also records, per arm, the
 * ULID the seed wrote (read from the facts dir) so the test can assert id-seed uniqueness.
 */
function staggeredRunner(): { runner: Runner; ulids: () => string[] } {
  let n = 0;
  const ulids: string[] = [];
  const runner: Runner = {
    async run(invocation, sandbox): Promise<RunResult> {
      const ordinal = n++;
      // Read the seeded fact to discriminate the arm (the on-disk seed the real conductor would recall).
      const factsDir = join(sandbox.workingDir, ".agentry", "memory", "facts");
      const files = existsSync(factsDir) ? readdirSync(factsDir) : [];
      const factText = files.map((f) => readFileSync(join(factsDir, f), "utf8")).join("\n");
      const isRelevant = factText.includes(RELEVANT_MARKER);
      // Record the ULID the seed wrote (embedded in the fact filename `...-<ULID>.md`) for the uniqueness assertion.
      for (const f of files) {
        const m = /-([0-9A-HJKMNP-TV-Z]{26})\.md$/.exec(f);
        if (m) ulids.push(m[1]!);
      }

      // Stagger: later launches finish first (delay shrinks with the ordinal), forcing out-of-order completion.
      await new Promise((r) => setTimeout(r, Math.max(0, 12 - ordinal)));

      if (isRelevant) {
        // one-shot: a non-empty produced tree, clean settle, NO work-folder artifact. Stream surfaces the signature.
        writeFileSync(join(sandbox.workingDir, "solution.ts"), "export const dedupe = true;\n", "utf8");
        writeStream(invocation.streamPath, `recalled the prior decision: ${FACT_SIGNATURE} — applying it now.`);
        return { streamPath: invocation.streamPath, resultSubtype: "success", producedTreeNonEmpty: true };
      }
      // decoy: spec-first — a spec.md under the work folder, non-empty recall, held at the floor.
      const slugDir = join(sandbox.workingDir, ".agentry", "work", "slug");
      mkdirSync(slugDir, { recursive: true });
      writeFileSync(join(slugDir, "spec.md"), "# spec\n", "utf8");
      writeStream(invocation.streamPath, "recalled some unrelated context; speccing first.");
      return { streamPath: invocation.streamPath, resultSubtype: "success", producedTreeNonEmpty: true };
    },
  };
  return { runner, ulids: () => ulids };
}

/** Write a synthetic stream.jsonl: one assistant message with a `memory_recall` tool_use + the given text. */
function writeStream(streamPath: string, text: string): void {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "memory_recall" }, { type: "text", text }] },
  });
  writeFileSync(streamPath, `${line}\n`, "utf8");
}

/** A canned judge: scores every produced tree GOOD (overall = 2.0/2 dims ⇒ clears RESULT_GOOD_THRESHOLD). Zero API. */
const goodJudge: JudgeFn = () =>
  JSON.stringify({ dimensions: { meetsIntent: 2, correct: 2, soundCode: 2, complete: 2 }, rationale: "canned" });

/** Drive the probe with the shared fake deps at a given concurrency, writing to a fresh temp out-path. */
async function runAt(fixtureDir: string, runner: Runner, concurrency: number, k: number): ReturnType<typeof runMoatProbe> {
  const outPath = join(mkdtempSync(join(tmpdir(), "moat-conc-out-")), "artifact.json");
  const opts: MoatProbeOptions = {
    fixtureDir,
    runner,
    judge: goodJudge,
    outPath,
    runs: k,
    concurrency,
    thresholdPath: THRESHOLDS,
  };
  return runMoatProbe(opts);
}

test("moat probe: concurrency > 1 yields the SAME outcomes + artifact as serial (determinism)", async () => {
  const fixtureDir = writeFixture();
  const k = 3;

  const { runner: serialRunner } = staggeredRunner();
  const { runner: parallelRunner } = staggeredRunner();

  const serial = await runAt(fixtureDir, serialRunner, 1, k);
  const parallel = await runAt(fixtureDir, parallelRunner, 4, k);

  // The per-(task,repeat) outcomes must be byte-for-byte identical, IN THE SAME ORDER (task-major / repeat), so every
  // downstream gate + aggregation consumes the exact same input regardless of which worker finished first.
  assert.deepEqual(parallel.outcomes, serial.outcomes, "outcomes identical + same order at concurrency 4 vs 1");

  // The scored artifact (rates, discrimination, census) must match exactly — the numbers cannot depend on concurrency.
  assert.deepEqual(parallel.artifact, serial.artifact, "scored artifact identical at concurrency 4 vs 1");

  // Sanity: this fixture actually exercises the compound path (relevant one-shots, decoy holds) so the test isn't
  // vacuously comparing two aborted artifacts.
  assert.equal(serial.artifact.condition, "scored");
  assert.equal(serial.artifact.compoundRate, 1, "every relevant repeat compounded (one-shot + landed + good)");
  assert.equal(serial.artifact.decoyLightenRate, 0, "no decoy lightened");
  assert.equal(serial.outcomes.length, 2 * k, "2 tasks × k repeats");
});

test("moat probe: every conduct gets a UNIQUE id-seed (ULIDs never collide under parallelism)", async () => {
  const fixtureDir = writeFixture();
  const k = 3;
  const { runner, ulids } = staggeredRunner();

  await runAt(fixtureDir, runner, 4, k);

  // 2 tasks × k repeats × 2 arms = 12 conducts, each seeded with its own pre-assigned id-seed ⇒ 12 distinct ULIDs.
  const seeded = ulids();
  assert.equal(seeded.length, 2 * k * 2, "one ULID seeded per conduct");
  assert.equal(new Set(seeded).size, seeded.length, "every seeded ULID is unique (no id-seed collision)");
});

test("moat probe: the default concurrency (omitted) stays serial and matches an explicit concurrency 1", async () => {
  const fixtureDir = writeFixture();
  const k = 2;

  const { runner: defaultRunner } = staggeredRunner();
  const { runner: oneRunner } = staggeredRunner();

  const outDefault = join(mkdtempSync(join(tmpdir(), "moat-conc-out-")), "artifact.json");
  const defaulted = await runMoatProbe({
    fixtureDir, runner: defaultRunner, judge: goodJudge, outPath: outDefault, runs: k, thresholdPath: THRESHOLDS,
  });
  const explicitOne = await runAt(fixtureDir, oneRunner, 1, k);

  assert.deepEqual(defaulted.outcomes, explicitOne.outcomes, "omitted concurrency === explicit 1");
  assert.deepEqual(defaulted.artifact, explicitOne.artifact);
});
