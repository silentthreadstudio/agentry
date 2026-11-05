// instruction-lint — the lines in a repo's instruction files that compete with the Agentry block:
// a rule that sends tasks, sessions, landings or the gate through a hand-written path where Agentry
// has a command for it. PURE: text in, findings out; no fs, no git. Suggest only: nothing here writes.
//
// RULES                                      the four rules, in the order they are tried
// lintText(name, text, { gateWords }) -> [{ file, line, rule, text, suggest }]
//
// A line counts only outside the Agentry block, a fenced code block and an HTML comment (an unclosed fence
// or comment runs to the end); inline code spans stay in, since commands live there. Matching ignores
// case and wants whole words. The first rule that fires wins: a line gives at most one finding.
// `gateWords` are the strings that name the repo's gate (none: no `gate-by-hand` rule); the first is the
// last tier's command joined, which the suggestion quotes.
import { maskBlocks, maskFences } from "./instructions.mjs";

const BOM = "﻿";
const SHOWN = 100;
// A command's name, not a longer one (`/agentry:go` is not `/agentry:goal`).
const command = (name) => new RegExp(`/agentry:${name}(?![\\w-])`, "i");
const GO = command("go");
const EXEC = command("exec");
const MERGE = command("merge");
const START_OR_CLOSE = new RegExp(`${command("start").source}|${command("close").source}`, "i");
const TASK = /\btasks?\b/i;
const SESSION = String.raw`(every|each|a|the|your)\s+(working\s+)?session\b`;
const SESSION_ROUTINE = [
  String.raw`\b(start|begin|open|end|close|finish)\w*\s+${SESSION}`,
  String.raw`\b(start|beginning|end|close)\s+of\s+${SESSION}`,
  String.raw`\bevery\s+session\s+(starts|begins|opens|ends|closes)\b`,
].map((re) => new RegExp(re, "i"));
const LAND = [
  /\bgit\s+(merge|cherry-pick)(?![\w-])/i,
  /\bgh\s+pr\s+merge(?![\w-])/i,
  /\bmerge\s+(it\s+|the\s+\w+\s+)?(in)?to\s+(main|master)\b/i,
];
const GATE_MOMENT = [
  /\b(before|after|prior to)\s+((every|each|any|a|the)\s+)?(commit|committing|push|pushing|merge|merging|land|landing)\b/i,
  /\balways\s+run\b/i,
];

/** The four rules in the order they are tried: `fires(line, gateWords)`, the `unless` pattern that
 *  names the Agentry command already, and `suggest(gateWords)`. */
export const RULES = [
  {
    rule: "go-for-tasks",
    fires: (line) => GO.test(line) && TASK.test(line),
    unless: EXEC,
    suggest: () =>
      "A task with a board id goes through `/agentry:exec <id>`; `/agentry:go` is for work with no board id.",
  },
  {
    rule: "session-routine",
    fires: (line) => SESSION_ROUTINE.some((re) => re.test(line)),
    unless: START_OR_CLOSE,
    suggest: () => "Every session starts with `/agentry:start` and ends with `/agentry:close`.",
  },
  {
    rule: "land-by-hand",
    fires: (line) => LAND.some((re) => re.test(line)),
    unless: MERGE,
    suggest: () =>
      "Landing a task's branch goes through `/agentry:merge <id>`; the repo's own landing checks go in a skill named in `extensions.merge.checks`.",
  },
  {
    rule: "gate-by-hand",
    fires: (line, gateWords = []) => {
      const low = line.toLowerCase();
      return (
        gateWords.some((word) => low.includes(word.toLowerCase())) &&
        GATE_MOMENT.some((re) => re.test(line))
      );
    },
    unless: new RegExp(`${EXEC.source}|${MERGE.source}`, "i"),
    suggest: (gateWords) =>
      `\`/agentry:exec\` and \`/agentry:merge\` run the gate (\`${gateWords[0]}\`); run it by hand only for a change made outside them.`,
  },
];

// A line as a finding shows it: trimmed, no carriage return, at most SHOWN code points.
function shown(line) {
  const chars = [...line.replaceAll("\r", "").trim()];
  return chars.length > SHOWN ? `${chars.slice(0, SHOWN - 1).join("")}…` : chars.join("");
}

// The text with what is not live blanked out, line ends kept: fences, then Agentry blocks, then comments.
const live = (text) =>
  maskBlocks(maskFences(text)).replace(/<!--[\s\S]*?(-->|$)/g, (m) => m.replace(/[^\r\n]/g, " "));

/** The competing lines of `text`, a file called `name`, in line order. Line 1 is the first line after a
 *  byte-order mark. */
export function lintText(name, text, { gateWords = [] } = {}) {
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  const lines = body.split("\n");
  const found = [];
  live(body)
    .split("\n")
    .forEach((line, i) => {
      if (!line.trim()) return;
      const rule = RULES.find((r) => r.fires(line, gateWords) && !r.unless.test(line));
      if (rule)
        found.push({
          file: name,
          line: i + 1,
          rule: rule.rule,
          text: shown(lines[i]),
          suggest: rule.suggest(gateWords),
        });
    });
  return found;
}
