// `renderPage` injects the run's data into the template. `String.replace` with a STRING replacement expands `$&`,
// `$'`, `` $` `` and `$$`, so a title or note holding one used to splice the template's tail into the data.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { PageData } from "../src/report/model.ts";
import { renderPage } from "../src/report/render.ts";

const MARKER = "<!--__SELFEVAL_DATA__-->";

test("renderPage keeps `$` sequences in the data verbatim", () => {
  const dir = mkdtempSync(join(tmpdir(), "selfeval-render-"));
  const templatePath = join(dir, "template.html");
  writeFileSync(templatePath, `<html>${MARKER}<p>TAIL</p></html>`);
  const title = "costs $& $' $` $$ and </script>";

  const html = renderPage({ title } as unknown as PageData, templatePath);

  const m = /window\.__SELFEVAL__ = (.*?);<\/script>/s.exec(html);
  assert.ok(m, "the data script is present");
  assert.deepEqual(JSON.parse(m[1] as string), { title });
  assert.equal(html.match(/TAIL/g)?.length, 1, "the template tail is not spliced into the data");
});
