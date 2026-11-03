// The plugin prompts' work-folder contract, read by the eval's own readers — ZERO API. Three sandboxes are written
// exactly as /agentry:go, spec, plan, split and the conducting/planning skills say (spec.md with title/status/kind/
// shape, plan.md, adr/, tasks/NNN-slug.md, the coverage matrix at the run root) and must read back as the routed
// shape, with every task file passing the single-frontmatter check.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { extractKind, extractShape } from "../src/conduct/extract.ts";
import type { Shape } from "../src/conduct/shape.ts";
import { runAllChecks } from "../src/honesty/flow-compliance/assertions.ts";
import { readRunTrace } from "../src/honesty/flow-compliance/trace.ts";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugin");
const SETTLED = { resultSubtype: "success", producedTreeNonEmpty: true };

const doc = (front: Record<string, string>, body: string): string =>
  `---\n${Object.entries(front)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n---\n\n${body}\n`;

/** A sandbox whose work folder is laid out as the prompts say; `coverageIn` places the matrix. */
function sandbox(
  shape: Shape,
  coverageIn: "root" | "tasks" = "root",
): { root: string; run: string } {
  const root = mkdtempSync(join(tmpdir(), `prompt-contract-${shape}-`));
  writeFileSync(join(root, "out.js"), "export {};\n");
  const run = join(root, ".agentry", "work", "fix-paginate");
  if (shape === "one-shot") return { root, run };
  mkdirSync(run, { recursive: true });
  const spec = { title: "Fix paginate", status: "draft", kind: "bug", shape };
  writeFileSync(join(run, "spec.md"), doc(spec, `Routed ${shape}: the cursor rule is undecided.`));
  if (shape !== "decompose") return { root, run };
  writeFileSync(
    join(run, "plan.md"),
    doc({ title: "Fix paginate", status: "draft" }, "## Approach"),
  );
  mkdirSync(join(run, "adr"));
  writeFileSync(join(run, "adr", "001-cursor.md"), doc({ title: "Cursor" }, "Y-statement"));
  mkdirSync(join(run, "tasks"));
  for (const [file, title] of [
    ["001-cursor-math.md", "Cursor math"],
    ["002-tests.md", "Tests"],
  ])
    writeFileSync(join(run, "tasks", file), doc({ title, status: "todo" }, "## Goal\nx"));
  const matrix = "| AC | tasks |\n|---|---|\n| AC1 | 001, 002 |\n";
  writeFileSync(join(run, ...(coverageIn === "root" ? [] : ["tasks"]), "coverage.md"), matrix);
  return { root, run };
}

for (const shape of ["one-shot", "spec-first", "decompose"] as const) {
  test(`a ${shape} work folder written to the prompts reads back as ${shape}`, () => {
    const { root } = sandbox(shape);

    assert.equal(extractShape(root, SETTLED), shape);
    assert.equal(extractKind(root), shape === "one-shot" ? null : "bug");
  });
}

test("the coverage matrix at the run root keeps every tasks/ file a single-frontmatter task", () => {
  const { run } = sandbox("decompose");

  const check = runAllChecks(readRunTrace(run)).checks.find((c) => c.id === "single-frontmatter");
  assert.equal(check?.status, "pass");
});

test("a coverage matrix under tasks/ would fail the single-frontmatter check (why it lives at the root)", () => {
  const { run } = sandbox("decompose", "tasks");

  const check = runAllChecks(readRunTrace(run)).checks.find((c) => c.id === "single-frontmatter");
  assert.equal(check?.status, "fail");
});

test("no plugin prompt puts the coverage matrix under tasks/", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? files(join(dir, e.name))
        : e.name.endsWith(".md")
          ? [join(dir, e.name)]
          : [],
    );
  const offenders = files(PLUGIN).filter((f) => readFileSync(f, "utf8").includes("tasks/coverage"));

  assert.deepEqual(offenders, []);
  for (const prompt of ["commands/split.md", "skills/planning/SKILL.md"])
    assert.ok(readFileSync(join(PLUGIN, prompt), "utf8").includes("<run>/coverage.md"), prompt);
});
