// Diagnostic: for each bench fixture, judge seed+golden (HIGH anchor) vs seed-alone (LOW anchor) with the REAL CODE
// judge, ×K draws, and print mean_gold / mean_seed / gap + the discrimination bars. Never aborts — surfaces EVERY
// non-discriminating fixture in one pass (the bench's controls stop at the first failure and hide the rest).

import { rmSync } from "node:fs";

import { CODE_RUBRIC } from "../src/bench/rubric.ts";
import { loadBenchFixtures } from "../src/bench/fixture.ts";
import { summarizeProducedResult } from "../src/conduct/result.ts";
import { judgeWithRubric, realJudgeFn, DEFAULT_JUDGE_MODEL } from "../src/judge/engine.ts";
import { prepareSandbox, seedSandbox } from "../src/io/sandbox.ts";

const K = 2;
const GOLD_MIN = 0.7, BROKEN_MAX = 0.4, MIN_GAP = 0.3;
const FIXTURES_DIR = "fixtures/bench";

const judgeOpts = { judge: realJudgeFn, model: DEFAULT_JUDGE_MODEL };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function viewOf(f: any) {
  return { id: f.id, prompt: f.prompt, shape: "one-shot", kind: "feature", oracleCmd: "",
    oracleTimeoutMs: 1000, seedDir: f.seedDir, oracleDir: f.oracleDir, goldenDir: f.goldenDir, brokenDir: f.brokenDir };
}

async function judgeOnce(f: any, withGolden: boolean): Promise<number> {
  const sandbox = prepareSandbox();
  try {
    seedSandbox(sandbox.workingDir, f.seedDir);
    if (withGolden) seedSandbox(sandbox.workingDir, f.goldenDir);
    const produced = summarizeProducedResult(sandbox.workingDir, viewOf(f) as any);
    const score = await judgeWithRubric(CODE_RUBRIC, f.prompt, produced.text, judgeOpts);
    return score.overall;
  } finally {
    rmSync(sandbox.workingDir, { recursive: true, force: true });
  }
}

// The real judge occasionally returns non-JSON on a draw; retry a couple times before giving up so one flaky draw
// doesn't crash the whole sweep.
async function judgeTree(f: any, withGolden: boolean): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await judgeOnce(f, withGolden);
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
  throw new Error("unreachable");
}

const only = new Set(process.argv.slice(2));
const fixtures = loadBenchFixtures(FIXTURES_DIR).filter((f) => only.size === 0 || only.has(f.id));
console.log(`fixture                gold   seed    gap   verdict`);
console.log(`---------------------- ----- ------ ------ -------`);
for (const f of fixtures) {
  try {
    const golds: number[] = [], seeds: number[] = [];
    for (let i = 0; i < K; i++) golds.push(await judgeTree(f, true));
    for (let i = 0; i < K; i++) seeds.push(await judgeTree(f, false));
    const g = mean(golds), s = mean(seeds), gap = g - s;
    const ok = g >= GOLD_MIN && s <= BROKEN_MAX && gap >= MIN_GAP;
    const why = !ok ? [g < GOLD_MIN && "gold<0.7", s > BROKEN_MAX && "seed>0.4", gap < MIN_GAP && "gap<0.3"].filter(Boolean).join(",") : "";
    console.log(`${f.id.padEnd(22)} ${g.toFixed(2)}  ${s.toFixed(2)}  ${gap.toFixed(2).padStart(5)}  ${ok ? "PASS" : "FAIL " + why}`);
  } catch (err) {
    console.log(`${f.id.padEnd(22)} ERR    ${(err as Error).message}`);
  }
}
