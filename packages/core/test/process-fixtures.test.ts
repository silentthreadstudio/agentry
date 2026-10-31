// The dependency-free board checker (`plugin/scripts/`) and core's schema must not drift: every
// synthetic fixture's process file and the process skill's template parse as a ProcessSpec, and
// `board.mjs check|status --json` on each fixture parses as a BoardReport.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BoardReport, ProcessSpec } from "../src/process.js";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugin");
const FIXTURES = join(PLUGIN, "scripts", "test", "fixtures");
const BOARD = join(PLUGIN, "scripts", "board.mjs");
const TEMPLATE = join(PLUGIN, "skills", "process", "templates", "process.json");
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

const fixtures = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
const valid = fixtures.filter((name) => name !== "broken");

test("every valid fixture's process file and the skill's template parse as a ProcessSpec", () => {
  assert.ok(valid.length >= 3);
  for (const name of valid) {
    const parsed = ProcessSpec.safeParse(readJson(join(FIXTURES, name, "process.json")));
    assert.ok(parsed.success, `${name}: ${parsed.success ? "" : parsed.error.message}`);
  }
  assert.ok(ProcessSpec.safeParse(readJson(TEMPLATE)).success, "templates/process.json");
});

test("the broken fixture is rejected by the schema too", () => {
  assert.equal(
    ProcessSpec.safeParse(readJson(join(FIXTURES, "broken", "process.json"))).success,
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
