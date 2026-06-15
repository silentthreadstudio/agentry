// R0 isolation smoke-test (Task T-003) — a THROWAWAY spike that empirically proves (or disproves)
// the core isolation mechanism for the benchmark harness: running `claude -p` under the REAL HOME
// while pointing AGENTRY_GLOBAL_DIR + AGENTRY_PROJECT_DIR at fresh temp dirs must yield a
// provably-empty pair of memory roots WITHOUT breaking auth. If this holds, T-005 (M2 arms/isolation)
// reuses the recipe; if not, the isolation design must change before M2 is built.
//
// Discipline: ONE real `claude -p` call, no retry loop. A failure is a recorded finding, not a reason
// to keep spending. The byte-empty-roots assertion logic (`countMemoryRecords`) is pure + unit-tested
// in test/smoke-isolation.test.ts; this module wires it to a real run.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Memory records on disk are one `.md` file per record under `<root>/facts/` and `<root>/episodes/`
 * (file-store is the source of truth — see packages/memory/src/persistence/file-store.ts). A root is
 * "byte-empty" when zero `.md` record files exist across both kinds. `memoryRoot` is the RESOLVED root
 * (`<base>/.agentry/memory`), i.e. what AGENTRY_*_DIR + `.agentry/memory` resolves to.
 *
 * Pure + side-effect-free (only reads the filesystem); a missing dir counts as zero, never throws.
 */
export function countMemoryRecords(memoryRoot: string): number {
  let count = 0;
  for (const kind of ["facts", "episodes"] as const) {
    const dir = join(memoryRoot, kind);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".md")) count++;
    }
  }
  return count;
}

/** The resolved memory root for an AGENTRY_*_DIR base dir (mirrors resolveRoots: base + `.agentry/memory`). */
export function memoryRootFor(baseDir: string): string {
  return join(baseDir, ".agentry", "memory");
}

/** True when both resolved roots hold zero record files. */
export function rootsAreEmpty(globalBase: string, projectBase: string): boolean {
  return (
    countMemoryRecords(memoryRootFor(globalBase)) === 0 &&
    countMemoryRecords(memoryRootFor(projectBase)) === 0
  );
}

/** The claude `--output-format json` result envelope — only the fields we assert on. */
interface ClaudeResultEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
}

/** A run succeeded iff claude returned a non-error `result` envelope (not an auth/plugin failure). */
export function runSucceeded(envelope: ClaudeResultEnvelope): boolean {
  return envelope.is_error === false && typeof envelope.result === "string" && envelope.result.length > 0;
}

// repo root = three dirs up from this file (benchmark/src/smoke/isolation.ts). Discovered, never hard-coded.
function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function main(): void {
  const root = repoRoot();

  // Two FRESH temp base dirs. AGENTRY_*_DIR are *base* dirs; resolveRoots appends `.agentry/memory`.
  const globalBase = mkdtempSync(join(tmpdir(), "agentry-r0-global-"));
  const projectBase = mkdtempSync(join(tmpdir(), "agentry-r0-project-"));

  const env = {
    ...process.env, // real HOME preserved → auth stays intact
    AGENTRY_GLOBAL_DIR: globalBase,
    AGENTRY_PROJECT_DIR: projectBase,
  };

  console.log("[R0] repo root:        ", root);
  console.log("[R0] AGENTRY_GLOBAL_DIR:", globalBase, "→ root:", memoryRootFor(globalBase));
  console.log("[R0] AGENTRY_PROJECT_DIR:", projectBase, "→ root:", memoryRootFor(projectBase));
  console.log("[R0] HOME (real):      ", process.env.HOME);

  // ONE real call. No retry loop — on error we capture and report, never re-spend.
  let raw: string;
  try {
    raw = execFileSync(
      "claude",
      ["-p", "say hi", "--output-format", "json", "--plugin-dir", root],
      { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (cause) {
    const err = cause as { stdout?: string; stderr?: string; message?: string };
    console.error("[R0] FAIL: `claude -p` exited non-zero — auth/plugin/CLI failure, NOT an isolation result.");
    console.error("[R0] stdout:", err.stdout ?? "");
    console.error("[R0] stderr:", err.stderr ?? err.message ?? String(cause));
    console.error("[R0] Record this as the broken step in findings/R0-isolation.md (a failure is a valid finding).");
    process.exit(1);
  }

  let envelope: ClaudeResultEnvelope;
  try {
    envelope = JSON.parse(raw) as ClaudeResultEnvelope;
  } catch {
    console.error("[R0] FAIL: could not parse `claude -p` JSON output. Raw:\n", raw);
    process.exit(1);
  }

  const authOk = runSucceeded(envelope);
  const empty = rootsAreEmpty(globalBase, projectBase);
  const globalRecords = countMemoryRecords(memoryRootFor(globalBase));
  const projectRecords = countMemoryRecords(memoryRootFor(projectBase));

  console.log("[R0] run result envelope:", JSON.stringify({
    type: envelope.type,
    subtype: envelope.subtype,
    is_error: envelope.is_error,
    result_preview: (envelope.result ?? "").slice(0, 80),
  }));
  console.log("[R0] auth/run success:   ", authOk);
  console.log("[R0] global root records:", globalRecords);
  console.log("[R0] project root records:", projectRecords);

  // Both must hold: empty roots AND a genuinely successful run. An auth failure that left the roots
  // empty is NOT a positive result — distinguish "empty because isolated" from "empty because failed".
  if (authOk && empty) {
    console.log("[R0] PASS: real HOME + AGENTRY_GLOBAL_DIR + AGENTRY_PROJECT_DIR → provably-empty roots, auth intact.");
    process.exit(0);
  }

  if (!authOk) {
    console.error("[R0] FAIL: run did not succeed (is_error/empty result) — empty roots here would be a false positive.");
  }
  if (!empty) {
    console.error("[R0] FAIL: roots are NOT byte-empty — the override did not relocate the roots (check MCP reload / env contract).");
  }
  process.exit(1);
}

// Only run the real call when executed directly — importing for tests must not spend an API call.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
