// load-metrics.mjs — build-time data seam (ADR 002 + ADR 003). Dependency-free Node ESM.
//
// One of the site's only two couplings to `packages/eval` (the other is embed-dashboard.mjs). The site
// CONSUMES eval's tracked outputs; it never touches eval internals (VISION §9).
//
// Two jobs, both run at `node scripts/load-metrics.mjs` from `packages/web/`:
//   1. ADR 002 — read the TRACKED `packages/eval/corrections.json` (the curated corrections log), validate
//      it (mirroring the shallow guard in `packages/eval/src/report/corrections.ts`), and emit a typed
//      `src/data/corrections.ts` (`export const corrections = [...] as const`) for Proof.astro (T7) to render.
//      The corrections log is the centerpiece "show the receipts" content; sourcing it from the same tracked
//      file the dashboard reads keeps the two from contradicting each other by construction.
//   2. ADR 003 — drift-check the brand-critical design tokens between the site's `src/styles/tokens.css` and
//      the dashboard template's `:root`, so the site and the receipts can't silently diverge on brand color.
//
// Fail-loud contract: unlike the reporter (which degrades a missing/malformed corrections file to `[]` because
// an absent trust section must not break a whole report), THIS script is a build step — a missing or malformed
// corrections.json means the site would ship without its centerpiece, so we exit non-zero and say why.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// --- paths (all anchored to this script's location, so cwd doesn't matter) ----------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(SCRIPT_DIR, ".."); // packages/web
const REPO_ROOT = join(WEB_ROOT, "..", ".."); // repo root

const CORRECTIONS_SRC = join(REPO_ROOT, "packages", "eval", "corrections.json");
const TEMPLATE_PATH = join(REPO_ROOT, "packages", "eval", "src", "report", "assets", "template.html");
const TOKENS_PATH = join(WEB_ROOT, "src", "styles", "tokens.css");
const OUT_PATH = join(WEB_ROOT, "src", "data", "corrections.ts");

/** Brand-critical tokens that MUST match between tokens.css and the dashboard template (ADR 003). Pure-canvas
 *  neutrals (`--bg`, `--panel`, …) legitimately differ — VISION §5 owns the site's neutrals — so they're excluded.
 *  Note: the site calls the brand-mark gradient `--brand`; the dashboard template calls it `--grad`. */
const BRAND_TOKENS = ["--amber", "--violet", "--violet-2", "--good", "--coral", "--cyan", "--bad", "--action"];
const SITE_GRADIENT_TOKEN = "--brand";
const TEMPLATE_GRADIENT_TOKEN = "--grad";

// --- ADR 002: corrections log --------------------------------------------------------------------------------

/** Shallow guard mirroring `packages/eval/src/report/corrections.ts`: an entry must carry the string fields the
 *  dashboard template reads. `high` is an optional severity flag (present in the data, coerced to boolean below). */
function isCorrection(x) {
  if (x === null || typeof x !== "object") return false;
  return (
    typeof x.date === "string" &&
    typeof x.h === "string" &&
    typeof x.meter === "string" &&
    typeof x.truth === "string" &&
    typeof x.fix === "string"
  );
}

/** Read + validate the tracked corrections.json. Fails loud (throws) on missing / unparseable / non-array /
 *  malformed-row input — a build step must not silently ship an empty or partial centerpiece. */
function loadCorrections() {
  if (!existsSync(CORRECTIONS_SRC)) {
    throw new Error(`corrections.json not found at ${CORRECTIONS_SRC} — cannot build the corrections log`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(CORRECTIONS_SRC, "utf8"));
  } catch (err) {
    throw new Error(`corrections.json is not valid JSON (${CORRECTIONS_SRC}): ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`corrections.json must be a JSON array (${CORRECTIONS_SRC})`);
  }
  if (parsed.length === 0) {
    throw new Error(`corrections.json is empty (${CORRECTIONS_SRC}) — the corrections log is the centerpiece`);
  }
  const bad = parsed.filter((x) => !isCorrection(x));
  if (bad.length > 0) {
    throw new Error(
      `corrections.json has ${bad.length} malformed row(s) (need string date/h/meter/truth/fix): ` +
        JSON.stringify(bad, null, 2),
    );
  }
  // Normalize to exactly the fields Proof.astro consumes; coerce `high` to a boolean (defaults false).
  return parsed.map((c) => ({
    date: c.date,
    high: Boolean(c.high),
    h: c.h,
    meter: c.meter,
    truth: c.truth,
    fix: c.fix,
  }));
}

/** Emit the typed `src/data/corrections.ts` module — a `Correction` interface + a frozen `corrections` const.
 *  This is the contract T7 (Proof.astro) imports. Generated, git-ignored, rebuilt every build. */
function emitCorrectionsModule(corrections) {
  const body = JSON.stringify(corrections, null, 2);
  const out = `// GENERATED by packages/web/scripts/load-metrics.mjs from packages/eval/corrections.json — DO NOT EDIT.
// Regenerate with: node scripts/load-metrics.mjs  (runs in the build's prebuild step). Git-ignored (ADR 002).
//
// The corrections log: curated episodes where the meter disagreed with the conductor and the conductor was
// right (the "show the receipts" centerpiece). Sourced from the SAME tracked file the eval dashboard reads,
// so the landing page and the dashboard cannot contradict each other (VISION §7).

/** One corrections-log entry — a time the meter was wrong and the conductor was right. */
export interface Correction {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** High-severity (a wrong number that would have shipped) vs. a refinement. */
  high: boolean;
  /** Headline — what was wrong. */
  h: string;
  /** What the meter said. */
  meter: string;
  /** What was actually true. */
  truth: string;
  /** How the meter (not the conductor) was fixed. */
  fix: string;
}

export const corrections = ${body} as const satisfies readonly Correction[];
`;
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, out);
}

// --- ADR 003: brand-token drift check ------------------------------------------------------------------------

/** Extract the ordered list of hex colors from a value (e.g. a gradient). The brand gradient is "brand-critical"
 *  by its COLORS (amber → coral → violet), not by its exact stop offsets: VISION §5 (the site's authority, AC6
 *  "match §5 exactly") fixes the site gradient as `…#ef8a5c 42%…` while the self-contained dashboard template
 *  uses explicit `0% / 45% / 100%` stops — and the template is eval-internal (VISION §9 forbids editing it). So a
 *  byte-exact gradient comparison would contradict the rest of the contract; the brand check compares the color
 *  sequence, which is what "the two surfaces feel like one product" actually means. (Solid tokens are still
 *  compared exactly — only gradients are color-normalized.) */
function colorsOf(value) {
  // Length-ordered alternation (8 → 6 → 4 → 3) so a trailing stop-offset digit (e.g. "#ef8a5c 42%" normalized to
  // "#ef8a5c42%") can't be swallowed into the hex — #rrggbb matches at 6, leaving the offset behind.
  return (value.match(/#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})/gi) ?? []).map((h) => h.toLowerCase());
}

/** Pull `--name: value;` declarations out of the first `:root { ... }` block of a CSS/HTML source. Tolerant of
 *  the site's packed one-line form (`--a:#x; --b:#y;`) and the template's pretty multi-line form (with comments). */
function parseRootTokens(text, label) {
  const open = text.indexOf(":root");
  if (open === -1) throw new Error(`${label}: no :root block found`);
  const braceStart = text.indexOf("{", open);
  const braceEnd = text.indexOf("}", braceStart);
  if (braceStart === -1 || braceEnd === -1) throw new Error(`${label}: malformed :root block`);
  const block = text.slice(braceStart + 1, braceEnd);
  const tokens = {}; // whitespace-normalized (exact compare for solid tokens)
  const raw = {}; // whitespace-preserved (so gradient color extraction sees the `#hex 42%` delimiter)
  // Match `--name: value` up to the next `;` (handles values with commas/parens like gradients).
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m;
  while ((m = re.exec(block)) !== null) {
    const value = m[2].trim().toLowerCase();
    raw[m[1]] = value;
    // Normalize whitespace so `135deg, #8b5cf6` and `135deg,#8b5cf6` compare equal.
    tokens[m[1]] = value.replace(/\s+/g, "");
  }
  return { tokens, raw };
}

/** Assert the brand-critical tokens match between the site and the dashboard template. The gradient token is
 *  named differently in each file (`--brand` site / `--grad` template), so it's compared by mapped name.
 *  Skips with a clear log (not a crash) if either file is absent — tokens.css is produced by T2 in parallel. */
function checkTokenDrift() {
  if (!existsSync(TOKENS_PATH)) {
    console.log(`[drift] skip: ${TOKENS_PATH} not present yet (T2 produces it) — token drift not checked.`);
    return;
  }
  if (!existsSync(TEMPLATE_PATH)) {
    console.log(`[drift] skip: dashboard template not found at ${TEMPLATE_PATH} — token drift not checked.`);
    return;
  }
  const { tokens: site, raw: siteRaw } = parseRootTokens(readFileSync(TOKENS_PATH, "utf8"), "tokens.css");
  const { tokens: tpl, raw: tplRaw } = parseRootTokens(readFileSync(TEMPLATE_PATH, "utf8"), "template.html");

  const mismatches = [];
  for (const name of BRAND_TOKENS) {
    if (site[name] === undefined) { mismatches.push(`${name}: missing from tokens.css`); continue; }
    if (tpl[name] === undefined) { mismatches.push(`${name}: missing from template :root`); continue; }
    if (site[name] !== tpl[name]) mismatches.push(`${name}: site "${site[name]}" vs template "${tpl[name]}"`);
  }
  // The brand gradient: --brand (site) and --grad (template) must share the same color sequence (see colorsOf).
  // Use the whitespace-PRESERVED raw values so a stop offset (`#hex 42%`) stays separate from its color.
  const siteGrad = siteRaw[SITE_GRADIENT_TOKEN];
  const tplGrad = tplRaw[TEMPLATE_GRADIENT_TOKEN];
  if (siteGrad === undefined) mismatches.push(`${SITE_GRADIENT_TOKEN}: missing from tokens.css`);
  else if (tplGrad === undefined) mismatches.push(`${TEMPLATE_GRADIENT_TOKEN}: missing from template :root`);
  else {
    const siteColors = colorsOf(siteGrad).join(",");
    const tplColors = colorsOf(tplGrad).join(",");
    if (siteColors !== tplColors) {
      mismatches.push(`brand gradient colors: site ${SITE_GRADIENT_TOKEN} [${siteColors}] vs template ${TEMPLATE_GRADIENT_TOKEN} [${tplColors}]`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `[drift] brand-critical token drift between tokens.css and the dashboard template (ADR 003):\n  - ` +
        mismatches.join("\n  - ") +
        `\nThe site and the receipts must feel like one product — align both, or update the brand decision.`,
    );
  }
  console.log(`[drift] OK: ${BRAND_TOKENS.length + 1} brand-critical tokens match the dashboard template.`);
}

// --- main ----------------------------------------------------------------------------------------------------

function main() {
  const corrections = loadCorrections();
  emitCorrectionsModule(corrections);
  console.log(`[metrics] wrote ${OUT_PATH} (${corrections.length} corrections).`);
  checkTokenDrift();
}

main();
