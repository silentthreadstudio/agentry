// Conformance test for the REALISTIC bench corpus under `fixtures/bench/` (the reshape plan §"Phase 2 — Realistic
// harder fixtures") — ZERO live API by construction. It drives the real fs load via `loadBenchFixtures`, then for
// each fixture PROVES the discrimination control by overlaying seed (+ golden/broken) into a temp sandbox, injecting
// the held-out oracle, and running it: seed+golden PASSES, seed+broken FAILS, and an untouched seed FAILS. It also
// asserts the corpus SPREAD the value bench's axes need (≥1 bugProne, ≥1 hidden-decision fork, ≥1 trivial), the
// BUG-marker control invariant (every broken tree carries a `BUG:` marker; no golden tree does — the canned judge
// keys on it), and that the shared Axis-A decision controls (`_controls/decision-{gold,poor}.md`) load.
//
// The oracle is run directly over overlaid copies, exactly as the probe's control gate does — no `claude -p`, no
// API spend. This is the credibility gate for the corpus: if a fixture cannot tell golden from broken, the bench
// built on it cannot either.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadBenchFixtures, type BenchFixture } from "../src/bench/fixture.ts";
import { injectOracle, runOracle } from "../src/rightsizing/oracle.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = join(HERE, "..", "fixtures", "bench");

const fixtures = loadBenchFixtures(BENCH_DIR);

/** Materialize seed (+ an optional golden/broken overlay) into a fresh sandbox, inject the oracle, run it. */
function runOracleOver(fx: BenchFixture, overlayDir: string | null): ReturnType<typeof runOracle> {
  const sandbox = mkdtempSync(join(tmpdir(), "bench-fx-"));
  try {
    cpSync(fx.seedDir, sandbox, { recursive: true });
    if (overlayDir) cpSync(overlayDir, sandbox, { recursive: true });
    injectOracle(sandbox, fx.oracleDir);
    return runOracle(sandbox, fx.oracleCmd, fx.oracleTimeoutMs);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/** Read every file under `dir` into one blob — used to scan a tree for the `BUG:` marker. */
function treeText(dir: string): string {
  const out: string[] = [];
  const walk = (cur: string): void => {
    for (const entry of readdirSync(cur)) {
      const abs = join(cur, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push(readFileSync(abs, "utf8"));
    }
  };
  walk(dir);
  return out.join("\n");
}

/** A fixture is "trivial" when it carries no hidden decision (no fork, or a fork explicitly "none…") and no bug. */
function isTrivial(fx: BenchFixture): boolean {
  return !fx.bugProne && (fx.fork === undefined || /^none\b/i.test(fx.fork));
}

/** A fixture carries a genuine hidden-decision fork when `fork` is present and does NOT begin "none…". */
function hasHiddenFork(fx: BenchFixture): boolean {
  return fx.fork !== undefined && !/^none\b/i.test(fx.fork);
}

// --- corpus-level: count + spread the value bench's axes need --------------------------------------------------

test("corpus: loads a realistic multi-fixture corpus (≥8)", () => {
  assert.ok(
    fixtures.length >= 8,
    `expected ≥8 bench fixtures, got ${fixtures.length}: ${fixtures.map((f) => f.id).join(", ")}`,
  );
});

test("corpus: every fixture has the four subtrees + a non-empty prompt and oracle command", () => {
  for (const fx of fixtures) {
    assert.ok(fx.prompt.length > 0, `${fx.id}: empty prompt`);
    assert.ok(fx.oracleCmd.length > 0, `${fx.id}: empty oracleCmd`);
    for (const dir of [fx.seedDir, fx.oracleDir, fx.goldenDir, fx.brokenDir]) {
      assert.ok(statSync(dir).isDirectory(), `${fx.id}: missing subtree ${dir}`);
    }
  }
});

test("corpus: spans the spread — ≥1 bugProne, ≥1 hidden-decision fork, ≥1 trivial", () => {
  const bugProne = fixtures.filter((f) => f.bugProne);
  const hiddenFork = fixtures.filter(hasHiddenFork);
  const trivial = fixtures.filter(isTrivial);

  assert.ok(bugProne.length >= 1, "no bugProne fixture (Axis-D escaped-defect set)");
  assert.ok(hiddenFork.length >= 1, "no hidden-decision fork fixture (Axis-A decision-quality)");
  assert.ok(trivial.length >= 1, "no trivial (correct-to-one-shot) fixture");
});

// --- the BUG-marker control invariant (the canned judge keys on it) -------------------------------------------

test("control invariant: every broken tree carries a `BUG:` marker and no golden tree does", () => {
  for (const fx of fixtures) {
    assert.match(treeText(fx.brokenDir), /BUG:/, `${fx.id}: broken/ must carry a BUG: marker`);
    assert.doesNotMatch(treeText(fx.goldenDir), /BUG:/, `${fx.id}: golden/ must NOT carry a BUG: marker`);
  }
});

// --- per-fixture: the discrimination control is REAL (golden passes, broken fails, seed fails) -----------------

for (const fx of fixtures) {
  test(`${fx.id}: seed+golden PASSES the oracle (discrimination, positive arm)`, () => {
    const r = runOracleOver(fx, fx.goldenDir);
    assert.equal(r.pass, true, r.output);
    assert.ok(r.total > 0 && r.passed === r.total, r.output);
  });

  test(`${fx.id}: seed+broken FAILS the oracle (discrimination, negative arm)`, () => {
    const r = runOracleOver(fx, fx.brokenDir);
    assert.equal(r.pass, false, r.output);
  });

  test(`${fx.id}: untouched seed FAILS the oracle (un-built control)`, () => {
    const r = runOracleOver(fx, null);
    assert.equal(r.pass, false, r.output);
  });
}

// --- bugProne fixtures: the subtle-bug probe genuinely bites the obvious (broken) build -----------------------

test("bugProne fixtures: the broken (obvious) build fails its oracle (the escaped-defect probe bites)", () => {
  const bugProne = fixtures.filter((f) => f.bugProne);
  assert.ok(bugProne.length >= 1, "expected at least one bugProne fixture");
  for (const fx of bugProne) {
    const r = runOracleOver(fx, fx.brokenDir);
    assert.equal(r.pass, false, `${fx.id}: the subtle-bug probe must FAIL the obvious build\n${r.output}`);
    assert.ok(r.total > 0, `${fx.id}: the oracle must actually run tests`);
  }
});

// --- the shared Axis-A decision controls load ------------------------------------------------------------------

test("decision controls: both _controls/decision-{gold,poor}.md load and gold names the fork", () => {
  const controlsDir = join(BENCH_DIR, "_controls");
  const gold = readFileSync(join(controlsDir, "decision-gold.md"), "utf8");
  const poor = readFileSync(join(controlsDir, "decision-poor.md"), "utf8");
  assert.ok(gold.length > 0, "decision-gold.md is empty");
  assert.ok(poor.length > 0, "decision-poor.md is empty");
  // The gold control's discriminating quality: it names the load-bearing fork and gives an override hint.
  assert.match(gold, /fork/i, "the gold decision control should name the load-bearing fork");
  assert.match(gold, /override/i, "the gold decision control should give an override hint");
});
