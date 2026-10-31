// Capture the RAW judge envelope for one fixture's seed+golden tree — no parse — to see what the model actually
// returns on the draws that fail `parseScore`. Runs N draws, prints status + raw `result` (truncated) per draw.

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

import { loadBenchFixtures } from "../src/bench/fixture.ts";
import { CODE_RUBRIC } from "../src/bench/rubric.ts";
import { summarizeProducedResult } from "../src/conduct/result.ts";
import { prepareSandbox, seedSandbox } from "../src/io/sandbox.ts";
import { DEFAULT_JUDGE_MODEL, buildJudgePrompt } from "../src/judge/engine.ts";

const f = loadBenchFixtures("fixtures/bench").find((x) => x.id === "bn-csv-parse");
if (f === undefined) throw new Error("fixture bn-csv-parse not found");
const sandbox = prepareSandbox();
seedSandbox(sandbox.workingDir, f.seedDir);
seedSandbox(sandbox.workingDir, f.goldenDir);
const produced = summarizeProducedResult(sandbox.workingDir, {
  id: f.id,
  prompt: f.prompt,
  shape: "one-shot",
  kind: "feature",
  oracleCmd: "",
  oracleTimeoutMs: 1000,
  seedDir: f.seedDir,
  oracleDir: f.oracleDir,
  goldenDir: f.goldenDir,
  brokenDir: f.brokenDir,
});
rmSync(sandbox.workingDir, { recursive: true, force: true });

const prompt = buildJudgePrompt(CODE_RUBRIC, f.prompt, produced.text);
console.log(`prompt chars: ${prompt.length}\n`);

for (let i = 0; i < 4; i++) {
  const proc = spawnSync(
    "claude",
    ["-p", prompt, "--output-format", "json", "--model", DEFAULT_JUDGE_MODEL],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  console.log(`=== draw ${i} : status=${proc.status} error=${proc.error?.message ?? "none"} ===`);
  if (proc.stderr) console.log(`stderr: ${proc.stderr.slice(0, 400)}`);
  let result: unknown;
  try {
    result = (JSON.parse(proc.stdout) as { result?: unknown }).result;
  } catch {
    result = `<<envelope not JSON>> ${proc.stdout.slice(0, 400)}`;
  }
  console.log(`result (${typeof result}): ${String(result).slice(0, 600)}\n`);
}
