// Flat Markdown PROJECTION of the scoreboard JSON (M7/T-009, ADR-002 Fork B). This is a *pure function of the
// assembled `Scoreboard`* — every line is derived mechanically from the JSON, nothing is authored or hand-
// tuned, and it is NEVER the AC9 comparison target (AC9 re-reads `scoreboard.json` via T-008's `reproducible()`).
// It is explicitly NOT a UI and NOT Phase 5 Workbench (Spec non-goal §2): just readable text for a human.
//
// The honest-null bar (AC13) is rendered VISIBLY: any claim whose verdict is `'null'` reads as
// "no measurable win" — never hidden, never rounded into a win. Because this is a projection, feeding two
// JSONs that differ only in a verdict produces two Markdown outputs that differ in exactly that line.

import type { Arm, ClaimVerdict, RegimeRow, Scoreboard } from "../types.ts";
import type { ScoreboardArtifact } from "./assemble.ts";

/** Human label for a verdict — the honest-null reads as a plain "no measurable win" (AC13). */
function verdictLabel(v: ClaimVerdict["verdict"]): string {
  switch (v) {
    case "win":
      return "win";
    case "loss":
      return "loss";
    case "null":
      return "no measurable win";
  }
}

/** Format a possibly-undefined number for display — `undefined` shows as `n/a`, NEVER as 0 (AC4). */
function num(n: number | undefined): string {
  if (n === undefined) return "n/a";
  return Number.isInteger(n) ? String(n) : n.toFixed(4);
}

/** A `met/total` count, or `n/a` when an arm has no R2 coverage (AC15 — a count, never a boolean). */
function coverage(entry: { met: number; total: number } | undefined): string {
  if (entry === undefined) return "n/a";
  return `${entry.met}/${entry.total}`;
}

const CLAIM_KEYS = ["c1", "c2", "c3", "c4"] as const;
const ARM_ORDER: readonly Arm[] = ["A", "B", "C"];

/** One C1–C4 claim line: id, verdict (honest-null visible), delta, variance. */
function renderClaim(id: string, claim: ClaimVerdict): string {
  return `| ${id.toUpperCase()} | ${verdictLabel(claim.verdict)} | ${num(claim.delta)} | ${num(
    claim.variance,
  )} |`;
}

/** One per-regime row: AC-pass rate per arm, plus tokens/turns per arm where the regime reports them (AC3). */
function renderRegimeRow(row: RegimeRow): string {
  const cells = ARM_ORDER.map((arm) => {
    const rate = row.acPassRateByArm[arm];
    const tokens = row.tokensByArm?.[arm];
    const turns = row.turnsByArm?.[arm];
    const parts: string[] = [`pass ${num(rate)}`];
    if (tokens !== undefined) parts.push(`tok ${num(tokens)}`);
    if (turns !== undefined) parts.push(`turns ${num(turns)}`);
    return rate === undefined && tokens === undefined && turns === undefined ? "—" : parts.join(", ");
  });
  return `| ${row.regime} | ${cells[0]} | ${cells[1]} | ${cells[2]} |`;
}

/**
 * Render the assembled scoreboard as flat Markdown — a pure projection of the JSON. `r2Coverage` (the AC15
 * count addendum) is rendered when present; a bare pinned `Scoreboard` (no addendum) still renders, omitting
 * the R2 coverage section. The output is fully determined by the input object (AC6/AC9: reproducible from the
 * JSON alone).
 */
export function renderMarkdown(sb: Scoreboard | ScoreboardArtifact): string {
  const lines: string[] = [];

  // --- C1–C4 claims (AC2): verdict + delta + variance, honest-null visible (AC13) ---
  lines.push("# Scoreboard");
  lines.push("");
  lines.push("## Claims (C1–C4)");
  lines.push("");
  lines.push("| Claim | Verdict | Delta | Variance |");
  lines.push("| --- | --- | --- | --- |");
  for (const key of CLAIM_KEYS) {
    lines.push(renderClaim(key, sb.claims[key]));
  }
  lines.push("");

  // Honest-null summary (AC13): name every claim with no measurable win, plainly.
  const nullClaims = CLAIM_KEYS.filter((key) => sb.claims[key].verdict === "null");
  if (nullClaims.length > 0) {
    for (const key of nullClaims) {
      lines.push(`> ${key.toUpperCase()}: no measurable win (honest null — effect inside variance).`);
    }
    lines.push("");
  }

  // --- Per-regime table (AC3): every regime present, per-arm metrics ---
  lines.push("## Per-regime");
  lines.push("");
  lines.push("| Regime | Arm A | Arm B | Arm C |");
  lines.push("| --- | --- | --- | --- |");
  for (const row of sb.perRegime) {
    lines.push(renderRegimeRow(row));
  }
  lines.push("");

  // --- R2 coverage (AC15): met/total per arm, a count not a boolean ---
  const coverageEntries = "r2Coverage" in sb ? sb.r2Coverage : undefined;
  if (coverageEntries !== undefined) {
    lines.push("## R2 coverage (met/total)");
    lines.push("");
    lines.push("| Arm | Met / total |");
    lines.push("| --- | --- |");
    for (const arm of ARM_ORDER) {
      if (coverageEntries[arm] === undefined) continue;
      lines.push(`| ${arm} | ${coverage(coverageEntries[arm])} |`);
    }
    lines.push("");
  }

  // --- R3 moat section (AC7): B/C on the same follow-up + the C−B delta, with the honest-null surfaced ---
  lines.push("## R3 moat (warm C vs cold B)");
  lines.push("");
  if (sb.r3.length === 0) {
    lines.push("_No R3 pairs in this run._");
    lines.push("");
  } else {
    lines.push("| Follow-up | B (cold) | C (warm) | C−B delta | Lesson reused |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const pair of sb.r3) {
      const moat =
        pair.warm.verdict === "null" && pair.cold.verdict === "null"
          ? `${num(pair.moatDelta)} (no measurable win in R3)`
          : num(pair.moatDelta);
      lines.push(
        `| ${pair.followUpTaskId} | ${num(pair.cold.delta)} | ${num(pair.warm.delta)} | ${moat} | ${
          pair.lessonReused ? "yes" : "no"
        } |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

