// embed-dashboard.mjs — build-time data seam (ADR 001). Dependency-free Node ESM.
//
// Produces `packages/web/public/dashboard/index.html` deterministically — the REAL eval dashboard artifact the
// Proof section links to ("show the receipts", VISION §7). The site only CONSUMES eval's tracked outputs; it
// never touches eval internals (VISION §9).
//
// Source precedence (ADR 001 — prefer the real generated artifact, fall back to the tracked-template floor):
//   1. A reporter-GENERATED dashboard in `packages/eval/results/<date>/<runId>/index.html`. When a real run
//      store has been reported locally, the committed `results/` tree holds a self-contained dashboard built
//      from live data — we copy the LATEST one. This is the richest, most truthful artifact.
//   2. The tracked dashboard TEMPLATE (`packages/eval/src/report/assets/template.html`), rendered with no data
//      injection so its baked SAMPLE fallback fills it. This is the deterministic floor.
//
// === SAMPLE-floor-in-CI (ADR 001, accepted for v1) ===
// CI checks out a tree with NO run store: `packages/eval/runs/` and `packages/eval/results/` are BOTH gitignored
// (.gitignore). So in CI there is no generated dashboard, and this script renders the tracked template — whose
// SAMPLE fallback produces a complete, real-LOOKING, byte-deterministic dashboard from committed files alone.
// That sample is a real, reproducible artifact (literally the dashboard the reporter emits sans live data), NOT
// an invented screenshot. The site's headline numbers are sourced separately (ADR 002), so the CI floor never
// publishes a fabricated metric. Locally, where `results/` exists, the published dashboard reflects a real run.
//
// Fail-loud contract: this script must NEVER write an empty / 0-byte page. If it cannot source EITHER a generated
// dashboard or the tracked template, it exits non-zero and says why — a broken deploy beats a silently empty one.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// --- paths (anchored to this script, so cwd doesn't matter) --------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(SCRIPT_DIR, ".."); // packages/web
const REPO_ROOT = join(WEB_ROOT, "..", ".."); // repo root

const RESULTS_ROOT = join(REPO_ROOT, "packages", "eval", "results");
const TEMPLATE_PATH = join(REPO_ROOT, "packages", "eval", "src", "report", "assets", "template.html");
const OUT_DIR = join(WEB_ROOT, "public", "dashboard");
const OUT_PATH = join(OUT_DIR, "index.html");

/** The placeholder the reporter replaces with injected run data (`render.ts`). Rendering the template with this
 *  marker removed (no injection) lets the template's own SAMPLE fallback render — the deterministic floor. */
const DATA_MARKER = "<!--__SELFEVAL_DATA__-->";

// --- source 1: the latest reporter-generated dashboard in results/ -------------------------------------------

/** Find the most recent `results/<date>/<runId>/index.html`, or null if the results tree has none. The layout is
 *  `<resultsRoot>/<YYYY-MM-DD>/<runId>/index.html` (emit.ts); run ids are time-sortable (`YYYYMMDD-HHMMSS-xxxx`),
 *  so lexical max over date then run id gives the latest. */
function findLatestGeneratedDashboard() {
  if (!existsSync(RESULTS_ROOT)) return null;
  const dates = listDirs(RESULTS_ROOT).sort();
  for (let i = dates.length - 1; i >= 0; i--) {
    const dateDir = join(RESULTS_ROOT, dates[i]);
    const runs = listDirs(dateDir).sort();
    for (let j = runs.length - 1; j >= 0; j--) {
      const candidate = join(dateDir, runs[j], "index.html");
      if (existsSync(candidate) && statSync(candidate).size > 0) return candidate;
    }
  }
  return null;
}

/** Directory names directly under `root` (empty list if `root` is absent). */
function listDirs(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

// --- source 2: the tracked template floor --------------------------------------------------------------------

/** Render the tracked template into a self-contained dashboard with no data injection (the SAMPLE floor). We
 *  remove the data marker so the template's `window.__SELFEVAL__ || SAMPLE` fallback renders the sample. The
 *  template is 0-external-ref, so the output works standalone under the `/agentry` base. Throws if the template
 *  is missing or lacks its marker (a loud failure beats shipping a page that can't render). */
function renderTemplateFloor() {
  if (!existsSync(TEMPLATE_PATH)) {
    throw new Error(`dashboard template not found at ${TEMPLATE_PATH} — no source for the embedded dashboard`);
  }
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  if (!template.includes(DATA_MARKER)) {
    throw new Error(`template ${TEMPLATE_PATH} is missing the ${DATA_MARKER} marker — refusing to emit a page that may not render`);
  }
  // No injection: drop the marker; the SAMPLE fallback fills the page.
  return template.replace(DATA_MARKER, "");
}

// --- main ----------------------------------------------------------------------------------------------------

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const generated = findLatestGeneratedDashboard();
  let source;
  if (generated !== null) {
    copyFileSync(generated, OUT_PATH);
    source = `generated dashboard (${generated})`;
  } else {
    const html = renderTemplateFloor();
    writeFileSync(OUT_PATH, html);
    source = "tracked template SAMPLE floor (no run store present — CI behavior, ADR 001)";
  }

  // Fail loud if, despite the above, the output is empty — never publish a 0-byte dashboard.
  const size = existsSync(OUT_PATH) ? statSync(OUT_PATH).size : 0;
  if (size === 0) {
    throw new Error(`embed-dashboard produced an empty ${OUT_PATH} — refusing to publish an empty dashboard`);
  }

  console.log(`[embed] wrote ${OUT_PATH} (${size} bytes) from ${source}.`);
}

main();
