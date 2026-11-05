// Tests for scripts/lib/private-refs.mjs: the gate's guard against comments that cite private docs, on
// synthetic trees, and over this repo's own tree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { privateRefs } from "./lib/private-refs.mjs";

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

// A tree with `files` ({ "plugin/a.mjs": text }) written under it.
function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), "private-refs-"));
  temps.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

test("privateRefs names each form of citation in a line, block or trailing comment", () => {
  for (const [text, hit] of [
    ["// the cap (field 84) is read live\n", "field 84"],
    ["const a = 1; // see ADR-005\n", "ADR-005"],
    ["/**\n * The shape (doc 07 §4).\n */\n", "doc 07"],
    ["// stacked lanes (A45) land after their parent\n", "A45"],
    ["// asserted by AC4\n", "AC4"],
    ["// the old T-003 lookup\n", "T-003"],
    ["// fixed in R1d-38\n", "R1d-38"],
    ["// the pinned F13 design\n", "F13"],
    ["// decision 51 allows it\n", "decision 51"],
    ["// (plan R1b-5)\n", "plan R1b"],
    ["// keep in step with the design docs (.docs/internal)\n", ".docs/"],
  ]) {
    const [problem, ...rest] = privateRefs(tree({ "plugin/scripts/a.mjs": text }));
    assert.deepEqual(rest, [], text);
    assert.match(
      problem,
      new RegExp(
        `^plugin/scripts/a\\.mjs:\\d+: comment cites a private reference \\(${hit.replace(/[()]/g, "\\$&")}`,
      ),
      text,
    );
  }
});

test("privateRefs reads typescript, astro and yaml comments under packages too", () => {
  const found = privateRefs(
    tree({
      "packages/x/src/a.ts": "export const a = 1; // ADR-002\n",
      "packages/web/src/b.astro": "// DocsLayout (ADR-001)\n",
      "packages/x/fixtures/t.yaml": "# floors (AC1)\nkey: value\n",
    }),
  );
  assert.equal(found.length, 3);
});

test("privateRefs reads scripts/ comments but not its own file or test", () => {
  const found = privateRefs(
    tree({
      "scripts/a.mjs": "// (field 7)\n",
      "scripts/lib/private-refs.mjs": "// (field 7)\n",
      "scripts/private-refs.test.mjs": "// (field 7)\n",
    }),
  );
  assert.deepEqual(found, ["scripts/a.mjs:1: comment cites a private reference (field 7)"]);
});

test("privateRefs leaves strings, usage examples and plain ids alone", () => {
  assert.deepEqual(
    privateRefs(
      tree({
        "plugin/scripts/a.mjs": [
          'const msg = "a name holds ADR-001 and field 84";',
          "const t = 'T-4'; // a usage example: lane merge T-4",
          "// SHA-256 of the file; Field 22 of /proc/<pid>/stat; the A/A control; decision 5-dim",
          'const url = "https://example.com/§";',
          "",
        ].join("\n"),
        "packages/x/README.md": "see ADR-001\n",
        "plugin/mem/index.js": "// ADR-001\n",
        "packages/x/node_modules/dep/index.js": "// ADR-001\n",
      }),
    ),
    [],
  );
});

test("privateRefs names each form of citation in shipped markdown, fenced code and inline code included", () => {
  for (const [text, hit] of [
    ["Stacked work (A45): start it.\n", "A45"],
    ["in the doc-01 format\n", "doc-01"],
    ["see doc 07 for the shape\n", "doc 07"],
    ["the cap (field 84) is read live\n", "field 84"],
    ["fixed by #97\n", "#97"],
    ["fixed in R1d-27\n", "R1d-27"],
    ["triage S46 asked for it\n", "S46"],
    ["recorded in ADR-005\n", "ADR-005"],
    ["see .docs/internal/07.md\n", ".docs/"],
    ["```\nagentry lane exec start T1 --cite A40\n```\n", "A40"],
    ["run `agentry x` (A23)\n", "A23"],
  ]) {
    const [problem, ...rest] = privateRefs(tree({ "plugin/skills/x/SKILL.md": text }));
    assert.deepEqual(rest, [], text);
    assert.match(
      problem,
      new RegExp(
        `^plugin/skills/x/SKILL\\.md:\\d+: prose cites a private reference \\(${hit.replace(/[.()]/g, "\\$&")}\\)$`,
      ),
      text,
    );
  }
});

test("privateRefs leaves the plugin's own words in markdown alone", () => {
  assert.deepEqual(
    privateRefs(
      tree({
        "plugin/commands/a.md": [
          "Run `agentry lane merge T-4` or `T-014`; the id is <id>.",
          "Acceptance criteria are `AC1..n`; an ADR-worthy fork goes to the architect.",
          "SHA-256 of the file; see the anchor `file.mjs#L42`; see learn.md § Wiring the lanes.",
          "Release 0.3.0-dev.12 and v1.2.3; the A/A control; a 5-dim decision",
          "",
        ].join("\n"),
        "packages/x/README.md": "see doc-01 and A45\n",
      }),
    ),
    [],
  );
});

test("privateRefs gives the line of the hit", () => {
  const [problem] = privateRefs(tree({ "plugin/a.mjs": "const a = 1;\n\n// (field 7)\n" }));
  assert.equal(problem, "plugin/a.mjs:3: comment cites a private reference (field 7)");
});

test("this repo's plugin and packages cite no private reference in a comment", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  assert.deepEqual(privateRefs(root), []);
});

test("in a git work tree only tracked files are read: an ignored build output is not shipped", () => {
  const root = mkdtempSync(join(tmpdir(), "private-refs-git-"));
  temps.push(root);
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  git("init", "-q");
  mkdirSync(join(root, "packages", "eval", "results"), { recursive: true });
  writeFileSync(join(root, "packages", "eval", "kept.mjs"), "// see ADR-002\n");
  writeFileSync(join(root, ".gitignore"), "packages/eval/results/\n");
  writeFileSync(join(root, "packages", "eval", "results", "out.html"), "<!-- ADR-003 -->\n");
  git("add", ".");
  assert.deepEqual(privateRefs(root), [
    "packages/eval/kept.mjs:1: comment cites a private reference (ADR-002)",
  ]);
});
