// The dependency-free board checker (`plugin/scripts/`) and core's schema must not drift: every
// synthetic fixture's process file parses as a ProcessBoard and its workflow file (when it has one) as a
// Workflow, so do the process skill's two templates, and `board.mjs check|status --json` on each fixture
// parses as a BoardReport.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BoardReport, ProcessBoard } from "../src/process.js";
import { Workflow } from "../src/workflow.js";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugin");
const FIXTURES = join(PLUGIN, "scripts", "test", "fixtures");
const BOARD = join(PLUGIN, "scripts", "board.mjs");
const TEMPLATES = join(PLUGIN, "skills", "process", "templates");
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

const fixtures = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
const valid = fixtures.filter((name) => name !== "broken");

test("every valid fixture's two files and the skill's two templates parse as ProcessBoard and Workflow", () => {
  assert.ok(valid.length >= 3);
  for (const name of valid) {
    const board = ProcessBoard.safeParse(readJson(join(FIXTURES, name, "process.json")));
    assert.ok(board.success, `${name}: ${board.success ? "" : board.error.message}`);
    const file = join(FIXTURES, name, "workflow.json");
    if (!existsSync(file)) continue;
    const workflow = Workflow.safeParse(readJson(file));
    assert.ok(workflow.success, `${name}: ${workflow.success ? "" : workflow.error.message}`);
  }
  assert.ok(
    ProcessBoard.safeParse(readJson(join(TEMPLATES, "process.json"))).success,
    "process.json",
  );
  assert.ok(
    Workflow.safeParse(readJson(join(TEMPLATES, "workflow.json"))).success,
    "workflow.json",
  );
});

test("the broken fixture is rejected by the schema too", () => {
  assert.equal(
    ProcessBoard.safeParse(readJson(join(FIXTURES, "broken", "process.json"))).success,
    false,
  );
});

test("board.mjs check --json and status --json parse as a BoardReport on every fixture", () => {
  for (const name of valid) {
    const root = join(FIXTURES, name);
    for (const sub of ["check", "status"]) {
      const out = spawnSync(
        "node",
        [BOARD, sub, "--json", "--root", root, "--process", join(root, "process.json")],
        { encoding: "utf8" },
      );
      assert.ok(
        out.status === 0 || out.status === 1,
        `${name} ${sub}: exit ${out.status} ${out.stderr}`,
      );
      const parsed = BoardReport.strict().safeParse(JSON.parse(out.stdout));
      assert.ok(parsed.success, `${name} ${sub}: ${parsed.success ? "" : parsed.error.message}`);
      assert.equal(parsed.data?.ok, out.status === 0);
      if (sub === "status") assert.ok(parsed.data?.status, `${name}: status carries the view`);
    }
  }
});
