// Tests for scripts/lib/doc-flags.mjs: the board/lane calls a doc's code names, and the gate's verdict
// on a synthetic plugin whose one subcommand takes `--apply` and `--json`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { docFlagProblems, mentions } from "./lib/doc-flags.mjs";

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

test("mentions reads inline spans and fenced lines, never prose or slash commands", () => {
  const text = [
    "Run `board fix --apply` then `lane sweep [--apply [--discard-ignored]]`.",
    "Prose board fix --nope is not code; `/agentry:board fix --accept T1` is a slash command.",
    "```sh",
    "board draft apply 3 --apply",
    "```",
    "`board` means the script.",
  ].join("\n");
  assert.deepEqual(mentions(text), [
    { cli: "board", sub: "fix", flags: ["--apply"], line: 1 },
    { cli: "lane", sub: "sweep", flags: ["--apply", "--discard-ignored"], line: 1 },
    { cli: "board", sub: "draft", flags: ["--apply"], line: 4 },
  ]);
});

test("a doc naming a flag or a subcommand the CLI lacks is a problem, with file and line", async () => {
  const plugin = mkdtempSync(join(tmpdir(), "doc-flags-"));
  temps.push(plugin);
  const cli = join(plugin, "scripts", "lib", "process", "cli");
  mkdirSync(cli, { recursive: true });
  writeFileSync(
    join(cli, "fix.mjs"),
    'export const help = { flags: { "--apply": "", "--accept <id>": "" } };\n',
  );
  mkdirSync(join(plugin, "commands"));
  writeFileSync(
    join(plugin, "commands", "board.md"),
    "`board fix --apply --accept T1 --root .`\n`board fix --dry-run`\n`board nope`\n",
  );
  assert.deepEqual(await docFlagProblems(plugin), [
    "commands/board.md:2: `board fix` takes no --dry-run",
    "commands/board.md:3: `board nope` is no board subcommand",
  ]);
});

test("mentions reads the agentry spellings, and `agentry draft` as board draft", () => {
  const text = "Run `agentry lane merge --push` or `agentry draft add --fields x`.";
  assert.deepEqual(mentions(text), [
    { cli: "lane", sub: "merge", flags: ["--push"], line: 1 },
    { cli: "board", sub: "draft", flags: ["--fields"], line: 1 },
  ]);
});
