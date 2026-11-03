// doc-flags — every `board <sub> …` and `lane <sub> …` a plugin doc names (commands, skills, agents),
// held to the options that subcommand's own `help` declares. A doc naming a subcommand the CLI lacks,
// or a flag it would refuse, is a problem: the docs are what the agents run. Read from code only:
// inline code spans and fenced blocks, where a command is written to be run.
//
// Written as `agentry board|lane <sub>` or `agentry draft`, or the bare `board|lane <sub>` the docs once used.
// mentions(text) -> [{ cli, sub, flags, line }]
// docFlagProblems(pluginDir) -> Promise<string[]>       "<file>:<line>: …" each
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const CLIS = { board: ["lib", "process", "cli"], lane: ["lib", "lane", "cli"] };
const ROUTER = ["--root", "--process", "--help"];
const COMMAND = /(?:^|[\s(])(board|lane)\s+([a-z][a-z-]*)((?:[^\S\n]+[^\s]+)*)/;
// `agentry draft …` is `agentry board draft …`
const DRAFT = /(?:^|[\s(])agentry\s+draft((?:[^\S\n]+[^\s]+)*)/;

// The code in `text` with the line each piece starts on: inline spans, and each line of a fenced block.
function code(text) {
  const out = [];
  let fenced = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) out.push({ code: line, line: i + 1 });
    else for (const m of line.matchAll(/`([^`]+)`/g)) out.push({ code: m[1], line: i + 1 });
  });
  return out;
}

const flagsIn = (text) => [...new Set(text.match(/--[a-z][a-z-]*/g) ?? [])];

/** Each `board|lane <sub>` the code in `text` names, with the `--flags` written after it. */
export function mentions(text) {
  return code(text).flatMap(({ code: c, line }) => {
    const d = DRAFT.exec(c);
    if (d) return [{ cli: "board", sub: "draft", flags: flagsIn(d[1]), line }];
    const m = COMMAND.exec(c);
    if (!m) return [];
    return [{ cli: m[1], sub: m[2], flags: flagsIn(m[3]), line }];
  });
}

const docsIn = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true })
        .filter((f) => f.endsWith(".md"))
        .map((f) => join(dir, f))
    : [];

/** What every doc under the plugin names that its CLI would refuse. */
export async function docFlagProblems(pluginDir) {
  const takes = {}; // "board fix" → Set of options, or null when there is no such subcommand
  const optionsOf = async (cli, sub) => {
    const key = `${cli} ${sub}`;
    if (!(key in takes)) {
      const file = join(pluginDir, "scripts", ...CLIS[cli], `${sub}.mjs`);
      const help = existsSync(file) ? (await import(pathToFileURL(file).href)).help : undefined;
      const own = Object.keys(help?.flags ?? {}).map((k) => k.split(" ")[0]);
      takes[key] = existsSync(file) ? new Set([...own, ...ROUTER]) : null;
    }
    return takes[key];
  };
  const problems = [];
  const docs = ["commands", "skills", "agents"].flatMap((d) => docsIn(join(pluginDir, d)));
  for (const file of docs) {
    const where = relative(pluginDir, file);
    for (const m of mentions(readFileSync(file, "utf8"))) {
      const ok = await optionsOf(m.cli, m.sub);
      if (!ok) problems.push(`${where}:${m.line}: \`${m.cli} ${m.sub}\` is no ${m.cli} subcommand`);
      else
        for (const flag of m.flags.filter((f) => !ok.has(f)))
          problems.push(`${where}:${m.line}: \`${m.cli} ${m.sub}\` takes no ${flag}`);
    }
  }
  return problems;
}
