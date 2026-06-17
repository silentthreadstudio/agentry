// The reporter's WRITE side + composition root (doc 08 §6). Given a stored run, it assembles the page data
// (`load.ts`), renders the HTML (`render.ts`), and writes a self-contained `results/<date>/<runId>/index.html` —
// the committed, reproducible dashboard artifact ("run the eval, get this page").
//
// SRP: orchestration + the single filesystem write. It owns no parsing (that's `load.ts`) and no templating (that's
// `render.ts`); it wires them and lands the file. The `results/` tree is the COMMITTED surface (distinct from the
// gitignored `runs/` store) — a date-then-run layout so a day's runs group together and the latest is easy to find.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildPageData } from "./load.ts";
import { renderPage } from "./render.ts";

/** Options for {@link emitReport}. */
export interface EmitOptions {
  /** Root for committed report output (`results/`). The page lands at `<resultsRoot>/<date>/<runId>/index.html`. */
  resultsRoot: string;
  /** Path to the curated corrections JSON (optional — absent ⇒ an empty corrections view). */
  correctionsPath?: string;
  /** ISO timestamp to stamp as the generation time + derive the `<date>` dir. Defaults to now. */
  now?: string;
}

/** Where the report was written. */
export interface EmitResult {
  /** The `results/<date>/<runId>/` directory created. */
  outDir: string;
  /** The full path to the written `index.html`. */
  outPath: string;
}

/**
 * Generate the dashboard for a stored run and write it under `results/<date>/<runId>/index.html`. Pure data in →
 * one HTML file out; no live API, no conductor re-run. `now` is injectable so a test can assert a fixed output path.
 */
export function emitReport(runsRoot: string, runId: string, opts: EmitOptions): EmitResult {
  const nowIso = opts.now ?? new Date().toISOString();
  const data = buildPageData(runsRoot, runId, {
    ...(opts.correctionsPath !== undefined ? { correctionsPath: opts.correctionsPath } : {}),
    generatedAt: nowIso,
  });
  const html = renderPage(data);

  const dateStamp = nowIso.slice(0, 10); // YYYY-MM-DD
  const outDir = join(opts.resultsRoot, dateStamp, runId);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "index.html");
  writeFileSync(outPath, html);

  return { outDir, outPath };
}
