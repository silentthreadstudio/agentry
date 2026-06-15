// Reading the HIDDEN SUITE — a task fixture's `grader/` directory (ADR-002 Fork A: the per-task fixture's
// sibling `grader/` dir of executable checks). This module is the seam T-007 (suite author) conforms to:
// the grader READS exactly the format documented below; T-007 AUTHORS exactly this format.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// THE grader/ DIR FORMAT (pinned by THIS module — T-007 conforms to it)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
//   <task-fixture>/
//     task.yaml          ← manifest (id, regime, prompt, …) — owned by the suite loader (T-007), NOT read here.
//     grader/
//       checks.json      ← THE hidden suite for this task: a JSON array of declarative CheckDecl objects.
//
//   checks.json is a JSON ARRAY (a SET — AC15 R2 coverage is `met / total` over its length). Each element is
//   one CheckDecl (see check.ts). Example:
//
//     [
//       { "id": "AC1-entry-exists",  "kind": "file_exists",   "path": "src/index.ts" },
//       { "id": "AC2-exports-run",   "kind": "file_contains", "path": "src/index.ts", "pattern": "export function run" },
//       { "id": "AC3-tests-pass",    "kind": "command",       "cmd": ["node", "--test", "test/run.test.js"], "expectExit": 0 }
//     ]
//
// RULES (load-bearing):
//   • Every `path`/`cmd` is interpreted RELATIVE TO THE PRODUCED TREE — never relative to the fixture. The
//     grader runs checks against what the agent produced (AC10 timing half: grade observed behavior post-run).
//   • checks.json is the ONLY file the grader reads from grader/. The dir is PHYSICALLY WITHHELD from the
//     sandbox by the arms (T-005) — it is never copied into the working tree, never concatenated into the
//     prompt (AC10 filesystem half). This module only ever reads it AFTER the run, off the fixture on disk.
//   • A check id should map 1:1 to the AC it proves; ids surface verbatim in GradeResult.perAc[].id.
//   • Keep checks AFFIRMATIVE (see check.ts's AC11 invariant): a check must observe something PRESENT to
//     pass, so an empty produced tree fails every check → 0% by construction.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { CheckDecl } from "./check.ts";

/** The parsed hidden suite for one task: an ordered SET of checks (AC15 counts over `checks.length`). */
export interface GraderFixture {
  /** The declared checks, in author order. Empty array is legal (a task with no checks grades 0/0). */
  checks: CheckDecl[];
}

/**
 * Read and parse a task fixture's `grader/checks.json` into a GraderFixture.
 * `graderDir` is the path to the fixture's `grader/` directory. Throws on a missing/malformed checks.json
 * (a broken hidden suite is a fixture bug to surface loudly, never to silently grade as 0/0).
 */
export function loadGraderFixture(graderDir: string): GraderFixture {
  const checksPath = join(graderDir, "checks.json");
  const raw = readFileSync(checksPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`grader fixture ${checksPath}: expected a JSON array of checks, got ${typeof parsed}`);
  }
  return { checks: parsed as CheckDecl[] };
}
