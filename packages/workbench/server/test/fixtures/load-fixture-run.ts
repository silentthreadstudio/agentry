// Shared test fixture loader — makes the workbench readers CI-portable.
//
// THE PROBLEM: the readers (FsWorkRepository / FsEventSource / FsReviewSidecarSource) resolve a run via
// FLOW's `runDir(cwd, run)` = `<cwd>/.agentry/work/<run>/`. Pointing them at the repo root reads the
// LIVE, gitignored `.agentry/work/` tree — present locally, ABSENT on a clean CI checkout, so the
// "real run" tests passed locally and failed in CI.
//
// THE FIX: a real FLOW run dir is committed as portable data under `fixtures/work-fixture/<RUN_ID>/`
// (a path with NO `.agentry` segment, so it is tracked, not ignored). This loader copies that committed
// dir into a fresh temp project root as `<tmp>/.agentry/work/<RUN_ID>/` and returns that temp cwd. The
// tests then construct the readers against the temp cwd instead of the repo root — same REAL on-disk
// shapes, but sourced from tracked bytes that exist on every checkout.
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

// The committed run dir — a real decompose+verify run (spec/plan/adr/tasks/events.jsonl/.review),
// captured under a NON-`.agentry` path so git tracks it.
export const FIXTURE_RUN = "build-agentry-workbench-the-agentry-agent-center-5s9v6deiit";

// The tracked source dir for the fixture run (used as the "does the run exist on disk" precondition).
export const FIXTURE_RUN_DIR = join(FIXTURES_DIR, "work-fixture", FIXTURE_RUN);

// Copy the committed fixture run into a fresh temp project root at `<tmp>/.agentry/work/<RUN_ID>/`
// and return that temp cwd. Caller owns cleanup (rmSync the returned dir, recursive + force).
export function loadFixtureRun(): string {
  const cwd = mkdtempSync(join(tmpdir(), "wb-fixture-"));
  cpSync(FIXTURE_RUN_DIR, join(cwd, ".agentry", "work", FIXTURE_RUN), { recursive: true });
  return cwd;
}
