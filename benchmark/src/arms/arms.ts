// The three experiment arms (Spec §4) — the ONLY thing that differs across them is the Agentry layer and
// its root state; model, settings, prompt, and sandbox are held constant (the confound rule). This module
// owns the arm → plugin-layer mapping; it does NOT touch the model or any other invocation field (those
// stay identical across arms, set by the orchestrator T-010):
//
//   A = plain  → NO Agentry layer at all (`--plugin-dir` OMITTED).
//   B = cold   → Agentry layer loaded (`--plugin-dir <repoRoot>`), empty roots.
//   C = warm   → Agentry layer loaded (`--plugin-dir <repoRoot>`), roots seeded by T-007 (M3).
//
// The `Arm` type is owned by ../types.ts and IMPORTED here (CLAUDE.md: never duplicate a contract type).
// The repo root is DISCOVERED (env override, else this file's location) — never hard-coded (CLAUDE.md
// generic constraint; mirrors the R0 spike's discovery).

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Arm } from "../types.ts";

/** Optional env override for the repo root to load the Agentry plugin from (B/C `--plugin-dir`). */
export const REPO_DIR_ENV = "AGENTRY_REPO_DIR";

/** True when the arm loads the Agentry layer (B and C); A is plain — no layer. */
export function armLoadsAgentry(arm: Arm): boolean {
  return arm !== "A";
}

/**
 * Discover the repo root to pass as `--plugin-dir` for arms B/C. Prefers the `AGENTRY_REPO_DIR` env
 * override; otherwise resolves it from this module's own location (benchmark/src/arms/arms.ts → three
 * dirs up = repo root). Never hard-coded.
 */
export function discoverRepoRoot(): string {
  const override = process.env[REPO_DIR_ENV];
  if (override && override.length > 0) return resolve(override);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/**
 * The plugin dir an arm contributes to the `Invocation.pluginDir` field.
 *
 * Arm A returns `undefined` — `claude -p` then receives NO `--plugin-dir`, so there is genuinely no
 * Agentry layer (not merely empty roots). Arms B/C return the discovered repo root. `repoRoot` defaults
 * to `discoverRepoRoot()` but is injectable for tests so they need not depend on the real tree location.
 */
export function armPluginDir(arm: Arm, repoRoot: string = discoverRepoRoot()): string | undefined {
  return armLoadsAgentry(arm) ? repoRoot : undefined;
}
