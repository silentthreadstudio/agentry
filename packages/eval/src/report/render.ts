// Composes the final dashboard HTML: read the static view template, inject the run's {@link PageData} as
// `window.__SELFEVAL__` at the `<!--__SELFEVAL_DATA__-->` marker. The template's client JS reads that global and
// falls back to its baked SAMPLE when absent (so the template previews standalone, and this injection overrides it).
//
// SRP: a PURE transform — `PageData` (+ template text) → HTML string. The only I/O is reading the template asset
// (a static file shipped beside this module); it writes nothing (that's `emit.ts`). This is what makes a generated
// page snapshot-testable: same data + same template → byte-identical HTML.
//
// Security: the JSON is serialized with `<` escaped to `<` so a value containing `</script>` cannot break out
// of the injected script tag. The data is our own run artifacts, but escaping the script-close sequence is the
// correct, cost-free habit for any HTML-embedded JSON.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PageData } from "./model.ts";

/** The static view template shipped beside this module (`report/assets/template.html`). */
const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "assets", "template.html");

/** The placeholder the reporter replaces with the data `<script>` (the template carries it before its runtime JS). */
const DATA_MARKER = "<!--__SELFEVAL_DATA__-->";

/**
 * Render a complete, self-contained dashboard page for `data`. Reads the template (override via `templatePath` for
 * tests), injects the page data at {@link DATA_MARKER}, and returns the full HTML. Throws if the template is missing
 * the marker — a loud failure beats silently emitting a page that renders only the baked sample.
 */
export function renderPage(data: PageData, templatePath: string = TEMPLATE_PATH): string {
  const template = readFileSync(templatePath, "utf8");
  if (!template.includes(DATA_MARKER)) {
    throw new Error(`renderPage: template ${templatePath} is missing the ${DATA_MARKER} marker`);
  }
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const injected = `<script>window.__SELFEVAL__ = ${json};</script>`;
  return template.replace(DATA_MARKER, injected);
}
