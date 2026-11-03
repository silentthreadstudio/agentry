// `board explain` and `board check` read `conductor.prompt` and `conductor.rules` against the repo: the
// prompt must be a file and hold the heading, found the way `rule apply` finds it. A miss is exit 2
// naming the key. Run as a process on a copy of the synthetic table board.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOARD = join(HERE, "..", "board.mjs");

// A copy of the table board whose process file carries `conductor`, and a prompt with `body` (none
// when null). Returns the CLI runner on it.
function repo(conductor, body) {
  const root = mkdtempSync(join(tmpdir(), "agentry-conductor-"));
  cpSync(join(HERE, "fixtures", "table-board"), root, { recursive: true });
  const file = join(root, "process.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), conductor }));
  if (body !== null) writeFileSync(join(root, "PROMPT.md"), body);
  const cli = (...args) =>
    spawnSync("node", [BOARD, ...args, "--root", root, "--process", file], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
  return { root, cli };
}

const NUMBERED = "# Prompt\n\n## 10. Standing rules\n\n- one\n\n## Other\n";

for (const sub of ["explain", "check"]) {
  test(`${sub}: a conductor.prompt that is not a file is exit 2 naming the key`, () => {
    const { root, cli } = repo({ prompt: "NOPE.md" }, null);
    try {
      const res = cli(sub);
      assert.equal(res.status, 2);
      assert.match(res.stderr, /conductor\.prompt "NOPE\.md" is not a readable file/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${sub}: a conductor.rules heading the prompt lacks is exit 2 naming what was looked for`, () => {
    const { root, cli } = repo({ prompt: "PROMPT.md", rules: "No such heading" }, NUMBERED);
    try {
      const res = cli(sub);
      assert.equal(res.status, 2);
      assert.match(res.stderr, /conductor\.rules "No such heading" is not a heading in PROMPT\.md/);
      assert.doesNotMatch(res.stderr, /nearest heading/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${sub}: a rules heading without its numbering misses, with the numbered heading as the hint`, () => {
    const { root, cli } = repo({ prompt: "PROMPT.md", rules: "Standing rules" }, NUMBERED);
    try {
      const res = cli(sub);
      assert.equal(res.status, 2);
      assert.match(res.stderr, /conductor\.rules "Standing rules" is not a heading/);
      assert.match(res.stderr, /nearest heading: "10\. Standing rules" \(line 3\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${sub}: the full heading text, numbering included, and a prompt alone are accepted`, () => {
    for (const conductor of [
      { prompt: "PROMPT.md", rules: "10. Standing rules" },
      { prompt: "PROMPT.md", rules: "## 10.  Standing   rules" },
      { prompt: "PROMPT.md" },
    ]) {
      const { root, cli } = repo(conductor, NUMBERED);
      try {
        assert.notEqual(cli(sub).status, 2, JSON.stringify(conductor));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
}
