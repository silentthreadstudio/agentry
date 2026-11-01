// The command names the trigger lines use, bound to the commands that exist (plan R1b-8, F18): the
// AGENTS.md block template, the conductor agent, the conductor prompt template and every command file
// name `/agentry:<name>`s, and each must be a file in `plugin/commands/`, or one of the pinned names
// still being built. The lane triggers appear in both the block and the agent, and the draft step names
// a `board draft add` that exists. Renaming a command, or a trigger in one place only, fails here.
// Run: node --test plugin/scripts/test/triggers-binding.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { usage as draftUsage } from "../lib/process/cli/draft.mjs";
import { appendLine } from "../lib/process/write.mjs";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMMANDS = join(PLUGIN, "commands");
const read = (...parts) => readFileSync(join(PLUGIN, ...parts), "utf8");

// Names the trigger sources may use before their command file exists. Empty: every command is built.
const PINNED = [];
// The lane triggers: each session's start and end, a board id, a landing, a question.
const TRIGGERS = ["start", "close", "exec", "merge", "ask"];

const BLOCK = read("skills", "process", "templates", "agents-block.md");
const AGENT = read("agents", "conductor.md");
const PROMPT = read("skills", "process", "templates", "CONDUCTOR.md");
const sources = {
  "templates/agents-block.md": BLOCK,
  "agents/conductor.md": AGENT,
  "templates/CONDUCTOR.md": PROMPT,
  ...Object.fromEntries(
    readdirSync(COMMANDS)
      .filter((f) => f.endsWith(".md"))
      .map((f) => [`commands/${f}`, read("commands", f)]),
  ),
};
const named = (text) => [
  ...new Set([...text.matchAll(/\/agentry:([a-z][a-z-]*)/g)].map((m) => m[1])),
];
const exists = (name) => existsSync(join(COMMANDS, `${name}.md`));

test("every /agentry:<name> in the trigger sources and the commands is a command or a pinned name", () => {
  const missing = Object.entries(sources).flatMap(([where, text]) =>
    named(text)
      .filter((name) => !exists(name) && !PINNED.includes(name))
      .map((name) => `${where}: /agentry:${name}`),
  );
  assert.deepEqual(missing, []);
});

test("the AGENTS.md block and the conductor agent both name every lane trigger", () => {
  for (const [where, text] of [
    ["agents-block.md", BLOCK],
    ["conductor.md", AGENT],
  ])
    assert.deepEqual(
      TRIGGERS.filter((name) => !named(text).includes(name)),
      [],
      `${where} is missing a trigger`,
    );
});

test("the block and the agent name the same Agentry commands, apart from the agent's own fallbacks", () => {
  // The agent also routes work with no board id (`/agentry:go`) and confirms drafts at
  // `/agentry:new decision`; the block leaves both to it.
  const agentOnly = ["go", "new"];
  const fromAgent = named(AGENT).filter((n) => !agentOnly.includes(n));
  const fromBlock = named(BLOCK).filter((n) => n !== "board");
  assert.deepEqual(fromBlock.sort(), fromAgent.sort());
});

test("the draft step names `board draft add`, and the board CLI has it", () => {
  assert.match(draftUsage, /^draft add\b/);
  assert.match(AGENT, /`board draft add`/);
  assert.match(BLOCK, /`\/agentry:board draft add`/);
  assert.match(read("commands", "board.md"), /draft list\|add/);
});

test("the block template has the conductor prompt slot and no marker of its own", () => {
  assert.match(BLOCK, /\{prompt\}/);
  assert.doesNotMatch(BLOCK, /agentry:(begin|end)/);
});

test("the conductor prompt template takes a standing rule under its rules heading", () => {
  // The heading `/agentry:init` writes as `conductor.rules` for this template; `board draft apply`
  // appends there.
  let out = appendLine(PROMPT, { heading: "Standing rules", line: "- one" });
  out = appendLine(out, { heading: "Standing rules", line: "- two" });
  assert.equal(out, `${PROMPT}\n- one\n- two\n`);
});
