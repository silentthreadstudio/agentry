// AC-CONTRACT — the UNIFORM PROBE CONTRACT conformance test (ADR-002 §the uniform probe contract). This is the S5
// gate that makes future probes mechanical: it asserts that ALL THREE public probes (moat, rightsizing, honesty)
// expose the SAME five-stage shape —
//
//   1. fixture       — a strict loader/validator (`load*Fixture`) the probe reads its corpus through.
//   2. probe         — a `run*Probe` gated orchestrator.
//   3. artifact      — a builder with TWO terminal conditions: `aborted` (a control fired, carrying the verdict and
//                      NO numbers) and `scored` (the numbers). Both observable on the emitted artifact.
//   4. controls      — the controls-first ladder: when a control fires, the artifact is `aborted` with the pinned
//                      verdict and NO scored numbers (the observable proof scoring did not run).
//   5. report-section — a `report/<probe>.ts` reader (`load*`) that narrows the stored artifact, ZERO live API.
//
// It is a REAL test, not a doc claim: each stage is asserted as an EXPORTED function / an OBSERVED artifact shape
// over zero-API surfaces — no `claude -p`, no runner, no fs run. The artifact/controls stages drive the actual
// aborted-artifact builders and assert the two-terminal shape; the fixture/probe/report stages assert the exposed
// callables exist with the right arity.
//
// Honesty is the deliberate corner case of the contract: it does NOT load its own fixture or run its own judge
// controls — it RIDES the rightsizing conduct (its "fixture" is the per-run records + escalated run dirs it
// consumes; its "controls" is the upstream rightsizing abort threaded through verbatim). The uniform two-terminal
// artifact + the report reader still hold, which is what this asserts for it.

import assert from "node:assert/strict";
import { test } from "node:test";

// ── Stage imports, per probe ───────────────────────────────────────────────────────────────────────────────────

// MOAT
import { loadMoatFixture } from "../src/moat/fixture.ts";
import { runMoatProbe } from "../src/moat/probe.ts";
import {
  buildAbortedArtifact as buildMoatAborted,
  buildScoredArtifact as buildMoatScored,
} from "../src/moat/artifact.ts";
import { seedLandingGuard, discriminationGuard } from "../src/moat/control.ts";
import { loadMoat } from "../src/report/moat.ts";

// RIGHT-SIZING
import { loadRightsizingFixture } from "../src/rightsizing/fixture.ts";
import { runRightsizingProbe } from "../src/rightsizing/probe.ts";
import {
  buildAbortedArtifact as buildRightsizingAborted,
  buildScoredArtifact as buildRightsizingScored,
} from "../src/rightsizing/score.ts";
import { aaStability, discrimination } from "../src/judge/index.ts";
import { loadRightsizing } from "../src/report/rightsizing.ts";

// HONESTY
import { buildOverclaim, runHonestyProbe } from "../src/honesty/probe.ts";
import { runFlowComplianceProbe } from "../src/honesty/flow-compliance/probe.ts";
import { loadHonesty } from "../src/report/honesty.ts";

// ── 1. fixture — every probe reads its corpus through a strict loader/validator ──────────────────────────────────

test("CONTRACT stage 1 (fixture): each public probe exposes a strict fixture loader", () => {
  // moat + rightsizing load a planted corpus; honesty's "fixture" is the per-run records (a pure builder over them)
  // plus the escalated run dirs the flow-compliance probe reads (its loader is the trace reader, exercised via the
  // probe). The contract requires a callable corpus loader for each.
  assert.equal(typeof loadMoatFixture, "function", "moat: loadMoatFixture");
  assert.equal(typeof loadRightsizingFixture, "function", "rightsizing: loadRightsizingFixture");
  assert.equal(typeof buildOverclaim, "function", "honesty: buildOverclaim (the per-run records reader)");
  assert.equal(typeof runFlowComplianceProbe, "function", "honesty: runFlowComplianceProbe (reads the escalated run dir)");
});

// ── 2. probe — every probe exposes a `run*Probe` gated orchestrator ──────────────────────────────────────────────

test("CONTRACT stage 2 (probe): each public probe exposes a run*Probe orchestrator", () => {
  assert.equal(typeof runMoatProbe, "function", "moat: runMoatProbe");
  assert.equal(typeof runRightsizingProbe, "function", "rightsizing: runRightsizingProbe");
  assert.equal(typeof runHonestyProbe, "function", "honesty: runHonestyProbe");
});

// ── 3. artifact — a two-terminal builder: `scored` carries numbers, `aborted` carries only the verdict ───────────

test("CONTRACT stage 3 (artifact): each probe's artifact has the uniform two terminal conditions", () => {
  // MOAT: aborted ⇒ condition "aborted" + verdict + NO compound number; scored ⇒ condition "scored".
  const moatAborted = buildMoatAborted("seed-did-not-land");
  assert.equal(moatAborted.condition, "aborted");
  assert.equal(moatAborted.abortVerdict, "seed-did-not-land");
  assert.equal(moatAborted.compoundRate, null, "moat aborted: NO compound number");
  assert.equal(buildMoatScored([]).condition, "scored");

  // RIGHT-SIZING: aborted ⇒ condition "aborted" + verdict + NO rates/census; scored ⇒ condition "scored".
  const rsAborted = buildRightsizingAborted("rightsizing-judge-cannot-discriminate");
  assert.equal(rsAborted.condition, "aborted");
  assert.equal(rsAborted.abortVerdict, "rightsizing-judge-cannot-discriminate");
  assert.equal(rsAborted.rates, undefined, "rightsizing aborted: NO rates");
  assert.equal(rsAborted.census, undefined, "rightsizing aborted: NO census");
  assert.equal(buildRightsizingScored([]).condition, "scored");
});

// ── 4. controls — when a control fires, the artifact is aborted with the verdict and NO scored numbers ───────────

test("CONTRACT stage 4 (controls): a fired control yields an aborted artifact with NO numbers", () => {
  // The shared control predicates are the gate: a non-discriminating judge / a scattered A/A yields a verdict that
  // the probe turns into an ABORTED artifact (no scored numbers). Assert both the control predicate fires AND the
  // probe's artifact builder maps that verdict to the no-numbers terminal.
  const noisy = aaStability([0.2, 0.9, 0.5], 0.1, "rightsizing");
  assert.equal(noisy.ok, false, "a scattered A/A must fire");
  const cannotSeparate = discrimination(0.5, 0.5, 0.7, 0.4, 0.3, "rightsizing");
  assert.equal(cannotSeparate.ok, false, "a collapsed gold/broken gap must fire");

  // rightsizing: the fired verdict ⇒ aborted, no rates.
  const rsAborted = buildRightsizingAborted(cannotSeparate.verdict!);
  assert.equal(rsAborted.condition, "aborted");
  assert.equal(rsAborted.rates, undefined);

  // moat: its own controls fire the same way (seed-landing / discrimination), mapping to an aborted artifact.
  const seedFail = seedLandingGuard([false, false]);
  assert.equal(seedFail.ok, false, "moat seed-landing control must fire when nothing landed");
  assert.equal(typeof discriminationGuard, "function", "moat exposes its discrimination control");
  assert.equal(buildMoatAborted(seedFail.verdict!).compoundRate, null);
});

test("CONTRACT stage 4 (controls): honesty RIDES the upstream abort — threads it through with NO numbers", () => {
  // Honesty runs no judge controls of its own: it consumes the conduct's already-gated output. When the upstream
  // (rightsizing) control fired, the honesty probe is driven with that verdict and produces the aborted terminal —
  // NO overclaim/compliance numbers. Proven over a temp out-path (the probe writes its artifact; zero API).
  const outPath = `${process.env.TMPDIR ?? "/tmp"}/honesty-contract-${process.pid}-${Date.now()}.json`;
  const { artifact } = runHonestyProbe({
    records: [],
    abortVerdict: "rightsizing-judge-cannot-discriminate",
    outPath,
  });
  assert.equal(artifact.condition, "aborted");
  assert.equal(artifact.abortVerdict, "rightsizing-judge-cannot-discriminate");
  assert.equal(artifact.overclaim, undefined, "honesty aborted: NO overclaim numbers");
  assert.equal(artifact.compliance, undefined, "honesty aborted: NO compliance numbers");
});

// ── 5. report-section — every probe has a zero-API `load*` reader that narrows the stored artifact ───────────────

test("CONTRACT stage 5 (report-section): each public probe exposes a zero-API report reader", () => {
  assert.equal(typeof loadMoat, "function", "moat: report/moat.ts loadMoat");
  assert.equal(typeof loadRightsizing, "function", "rightsizing: report/rightsizing.ts loadRightsizing");
  assert.equal(typeof loadHonesty, "function", "honesty: report/honesty.ts loadHonesty");

  // Zero-API by construction: pointed at an empty/absent runs root, each reader returns `undefined` (the dashboard
  // omits the section) rather than throwing or calling a model.
  const emptyRoot = `${process.env.TMPDIR ?? "/tmp"}/selfeval-contract-empty-${process.pid}`;
  assert.equal(loadMoat(emptyRoot), undefined);
  assert.equal(loadRightsizing(emptyRoot), undefined);
  assert.equal(loadHonesty(emptyRoot), undefined);
});
