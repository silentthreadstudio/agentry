// Every `board` and `lane` subcommand carries the one help format (lib/cli/help.mjs): a usage line, a
// one-line purpose, its args and flags, its exit codes and an example of itself; and `--help` prints
// it, exit 0, without a process file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { flagsOf, say } from "../lib/cli/help.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIS = {
  board: join(HERE, "..", "lib", "process", "cli"),
  lane: join(HERE, "..", "lib", "lane", "cli"),
};

for (const [cli, dir] of Object.entries(CLIS))
  for (const file of readdirSync(dir)) {
    const sub = file.replace(/\.mjs$/, "");
    test(`${cli} ${sub}: its help has every part`, async () => {
      const { help } = await import(pathToFileURL(join(dir, file)).href);
      assert.ok(help, "exports help");
      for (const u of [help.usage].flat()) assert.match(u, new RegExp(`^${sub}\\b`));
      assert.match(help.purpose, /^[A-Z].*\.$/, "one sentence");
      assert.ok(!help.purpose.includes("\n"), "one line");
      assert.equal(typeof help.args, "object");
      for (const key of Object.keys(help.flags)) assert.match(key, /^--[a-z-]+( .+)?$/);
      assert.ok(Object.hasOwn(help.exits, 0), "exit 0 is described");
      assert.equal(flagsOf(help)["--json"], false, "takes --json, an output switch");
      for (const code of Object.keys(help.exits)) assert.ok(["0", "1", "2"].includes(code));
      assert.match(help.example, new RegExp(`^${cli} ${sub}\\b`));
      // Every flag the usage line names is one the parser takes.
      const named =
        [help.usage]
          .flat()
          .join(" ")
          .match(/--[a-z-]+/g) ?? [];
      for (const flag of named) assert.ok(Object.hasOwn(flagsOf(help), flag), flag);
    });
  }

test("--help on a sub prints its help and exits 0, with no process file around", () => {
  const empty = tmpdir();
  const res = spawnSync(
    "node",
    [join(HERE, "..", "lane.mjs"), "merge", "--help", "--root", empty],
    {
      encoding: "utf8",
    },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^usage: lane merge <id>/);
  assert.match(res.stdout, /\nexits:\n {2}0 {2}done, next printed\n/);
});

test("an error is one line: ✗ what: why → next", () => {
  assert.equal(
    say("board set", "no task T9", "board status"),
    "✗ board set: no task T9 → board status",
  );
  assert.equal(say("board set", "no task T9"), "✗ board set: no task T9");
});

test("--help, on a sub and on the index, ends with the plugin's version", () => {
  const { version } = JSON.parse(
    readFileSync(join(HERE, "..", "..", ".claude-plugin", "plugin.json"), "utf8"),
  );
  for (const args of [["merge", "--help"], ["--help"]]) {
    const res = spawnSync("node", [join(HERE, "..", "lane.mjs"), ...args, "--root", tmpdir()], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trimEnd().split("\n").at(-1), `agentry plugin ${version}`);
  }
});
