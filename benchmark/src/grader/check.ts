// A single CHECK — the atom of the deterministic grader (ADR-001). One check is a labeled, independently
// scored behavioral assertion run against the PRODUCED tree (never against the suite). Each check scores on
// its own, so AC15 (R2 set-coverage) falls straight out of the runner as `met / total`.
//
// THE AC11 INVARIANT (non-negotiable, structural): every check kind is an AFFIRMATIVE PROBE — it can only
// return `passed: true` when it OBSERVES something present in the produced tree (a file, matching content, a
// command that exits as expected). Absence — a missing file, an unreadable tree, a command that fails to run
// — always yields `passed: false`. There is no kind that passes on "nothing happened". This is what makes an
// empty/no-op tree score exactly 0% by construction (ADR-001's whole reason to exist), and it is why a check
// must never be written to pass on a thrown error or a missing path.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A declared check, as authored in a task fixture's `grader/checks.json` (the format T-007 conforms to —
 * see fixture.ts). The runner hard-codes no task specifics: it executes whatever the fixture declares.
 *
 * Every kind names a `path` (or `cmd`) RELATIVE to the produced tree root, and every kind is an affirmative
 * probe (see the AC11 invariant above).
 */
export type CheckDecl =
  | {
      /** Unique id within the fixture; surfaces verbatim as `GradeResult.perAc[].id`. */
      id: string;
      /** The relative path that must EXIST in the produced tree. Absent file → fail. */
      kind: "file_exists";
      path: string;
    }
  | {
      id: string;
      /** The relative file whose content must MATCH `pattern` (a JS regex source). Absent/no-match → fail. */
      kind: "file_contains";
      path: string;
      /** Regex source tested against the file's UTF-8 content (e.g. "export function foo"). */
      pattern: string;
    }
  | {
      id: string;
      /** A command run with cwd = the produced tree root; PASSES iff it exits with `expectExit` (default 0). */
      kind: "command";
      /** argv: `cmd[0]` is the executable, the rest are args. Run with NO shell (no string interpolation). */
      cmd: string[];
      /** Expected exit code; omit for 0. A command that cannot be spawned (ENOENT) is a fail, never a pass. */
      expectExit?: number;
    };

/** The independently-scored outcome of one check — mirrors one `GradeResult.perAc[]` entry. */
export interface CheckResult {
  id: string;
  passed: boolean;
  /** The assertion that ran, recorded for mechanical audit ("why did this score?"). */
  evidence: string;
}

/**
 * Run ONE check against the produced tree rooted at `treeRoot`. Pure w.r.t. the suite (it reads only the
 * produced tree, never the fixture). NEVER throws — any failure to observe (missing file, unreadable path,
 * un-spawnable command, non-matching content) collapses to `passed: false` with auditable evidence, which is
 * exactly the AC11 invariant: absence cannot pass.
 */
export function runCheck(check: CheckDecl, treeRoot: string): CheckResult {
  switch (check.kind) {
    case "file_exists":
      return probeFileExists(check, treeRoot);
    case "file_contains":
      return probeFileContains(check, treeRoot);
    case "command":
      return probeCommand(check, treeRoot);
  }
}

function probeFileExists(check: { id: string; path: string }, treeRoot: string): CheckResult {
  const full = join(treeRoot, check.path);
  try {
    readFileSync(full); // present & readable → observed
    return { id: check.id, passed: true, evidence: `file_exists: ${check.path} present` };
  } catch {
    return { id: check.id, passed: false, evidence: `file_exists: ${check.path} ABSENT` };
  }
}

function probeFileContains(
  check: { id: string; path: string; pattern: string },
  treeRoot: string,
): CheckResult {
  const full = join(treeRoot, check.path);
  let content: string;
  try {
    content = readFileSync(full, "utf8");
  } catch {
    return { id: check.id, passed: false, evidence: `file_contains: ${check.path} ABSENT` };
  }
  const re = new RegExp(check.pattern);
  if (re.test(content)) {
    return { id: check.id, passed: true, evidence: `file_contains: ${check.path} matches /${check.pattern}/` };
  }
  return { id: check.id, passed: false, evidence: `file_contains: ${check.path} present but NO match for /${check.pattern}/` };
}

function probeCommand(
  check: { id: string; cmd: string[]; expectExit?: number },
  treeRoot: string,
): CheckResult {
  const expect = check.expectExit ?? 0;
  const [bin, ...args] = check.cmd;
  if (bin === undefined) {
    return { id: check.id, passed: false, evidence: `command: empty cmd[] (nothing to run)` };
  }
  const printable = check.cmd.join(" ");
  try {
    execFileSync(bin, args, { cwd: treeRoot, stdio: "ignore" });
    // execFileSync resolves only on exit 0.
    return exitResult(check.id, printable, 0, expect);
  } catch (err) {
    const status = (err as { status?: number | null }).status;
    if (typeof status === "number") {
      return exitResult(check.id, printable, status, expect);
    }
    // Could not spawn at all (ENOENT, etc.) — absence of the tool/command is a FAIL, never a pass.
    return { id: check.id, passed: false, evidence: `command: \`${printable}\` failed to run (${(err as Error).message})` };
  }
}

function exitResult(id: string, printable: string, actual: number, expect: number): CheckResult {
  const passed = actual === expect;
  return {
    id,
    passed,
    evidence: `command: \`${printable}\` exited ${actual} (expected ${expect})`,
  };
}
