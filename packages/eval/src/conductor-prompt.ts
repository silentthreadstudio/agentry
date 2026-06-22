// The headless conductor prompt — the ONE correct way the self-eval invokes Agentry's `/agentry:go` front door
// under `claude -p`. Shared by every probe that runs "through Agentry" (routing, outcome, …).
//
// WHY THIS EXISTS (a measurement-validity fix): a bare `claude -p "/agentry:go <task>"` is a 0-TURN NO-OP in
// print mode — the slash command expands and the process exits WITHOUT ever running the model (verified:
// num_turns 0, ~66ms, no work done). So invoking the front door via the slash form measures NOTHING (the
// conductor never runs; routing then reads an empty work folder and mislabels every run "one-shot"). The fix:
// deliver the command's CONTENT as a plain prompt — read `plugin/commands/go.md`, strip frontmatter, substitute
// `$ARGUMENTS` with the task + the auto-pilot directive. The conducting skill (loaded via `--plugin-dir`) then
// routes it for real (verified: 3+ turns + a correct, right-sized solution).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Auto-pilot directive appended to the conductor prompt. Headless runs have NO interactive user, so the conductor
 * must never block on a gate — it decides every fork itself and records any escalation as a work-folder artifact
 * (which makes the routing decision OBSERVABLE to the artifact-reading probes). This sets the MODE only, never the
 * routing answer; the shape decision (one-shot / spec-first / decompose) stays entirely the conductor's.
 */
export const AUTOPILOT_DIRECTIVE =
  "\n\n[AUTO-PILOT MODE — AGENTRY_AUTOPILOT=1]: Operate per the conducting skill's auto-pilot mode. Do NOT block " +
  "and do NOT call AskUserQuestion — there is no interactive user. For EVERY decision fork you would otherwise " +
  "ask about, decide the best option yourself with a stated rationale. CRITICAL: for ANY task that escalates " +
  "above a trivial one-shot (it hides a decision, spans multiple components, or needs a plan), you MUST write the " +
  "routing artifact to `.agentry/work/<slug>/` BEFORE building — a `spec.md` at minimum (and `plan.md` + `tasks/` " +
  "if you decompose) — recording each auto-decided fork + its assumption + a one-line override hint. A genuinely " +
  "trivial one-shot writes no work-folder artifact. Then proceed to build.";

/**
 * Build the headless conductor prompt: the EXPANDED `/agentry:go` command content (never the 0-turn slash form).
 * Reads `<pluginRoot>/plugin/commands/go.md`, strips its YAML frontmatter, and substitutes `$ARGUMENTS` with the
 * task + the auto-pilot directive. `pluginRoot` is the `--plugin-dir` value (the repo root that holds `plugin/`).
 * Falls back to a minimal conductor framing when the command file isn't on disk (e.g. a synthetic test root) — so
 * the prompt is always a real model prompt, never the slash no-op.
 */
export function buildConductorPrompt(pluginRoot: string, task: string): string {
  const goPath = join(pluginRoot, "plugin", "commands", "go.md");
  const body = existsSync(goPath)
    ? readFileSync(goPath, "utf8").replace(/^---[\s\S]*?---\n/, "")
    : "You are Agentry's conductor. Route this task to the least process that wins (one-shot → spec-first → decompose+verify) and conduct it end to end:\n\n$ARGUMENTS";
  return body.replace(/\$ARGUMENTS/g, task + AUTOPILOT_DIRECTIVE);
}
