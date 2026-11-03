// conductor — the file-level check of `conductor.prompt` and `conductor.rules`. The process file's
// validator only judges their shape; this reads the repo: the prompt must exist inside it and hold the
// rules heading, found the way `rule apply` finds it (`section()`: the full heading text, spaces
// collapsed, numbering included). `board explain` and `board check` refuse (exit 2) on a miss, so a
// wrong key is caught where it is written, not later at `board draft apply`.
//
// conductorProblems(root, spec) -> string[]      each message names the key and what was looked for
// refuseConductor(root, spec, processPath) -> { exit: 2, out } | null
import { join, relative } from "node:path";
import { say } from "../cli/help.mjs";
import * as md from "./markdown.mjs";
import { readInside } from "./read.mjs";

// A heading without its leading number (`10. Standing rules` → `standing rules`), for the hint only.
const bare = (text) =>
  text
    .replace(/^\s*#*\s*(\d+(\.\d+)*[.)]?\s+)?/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

// The prompt's first heading that differs from `wanted` only by numbering or case, or contains it.
function nearest(text, wanted) {
  const want = bare(wanted);
  if (!want) return null;
  return (
    md.headings(text).find((h) => bare(h.text) === want || bare(h.text).includes(want)) ?? null
  );
}

export function conductorProblems(root, spec) {
  const { prompt, rules } = spec.conductor ?? {};
  if (!prompt) return [];
  const text = readInside(root, join(root, prompt));
  if (text === null)
    return [`conductor.prompt "${prompt}" is not a readable file in the repository`];
  if (rules === undefined || md.section(text, rules)) return [];
  const near = nearest(text, rules);
  const hint = near ? `; nearest heading: "${near.text}" (line ${near.line})` : "";
  return [`conductor.rules "${rules}" is not a heading in ${prompt}${hint}`];
}

export function refuseConductor(root, spec, processPath) {
  const problems = conductorProblems(root, spec);
  if (!problems.length) return null;
  const rel = relative(root, processPath);
  const shown = rel.startsWith("..") ? processPath : rel;
  const head = say(shown, "cannot use the process file", "/agentry:init");
  return { exit: 2, out: [head, ...problems.map((p) => `  ${p}`)].join("\n") };
}
