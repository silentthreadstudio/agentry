// board instructions --lint — reads the repo's instruction files and points at the lines that compete with
// the Agentry block (A41), each with the replacement to offer. Suggest only: it never writes. Read in this
// order, each once (a link to a file already read is not read again): AGENTS.md, CLAUDE.md,
// .claude/CLAUDE.md, CLAUDE.local.md and the workflow file's `conductor.prompt`. A file that is absent is
// skipped; one that can't be read prints `skip: <name>: <why>` and the rest still run. Exit 1 with
// findings, else 0.
//
// runLint({ root, spec }, { json }) -> { exit, out }   what `board instructions --lint` calls
import { statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { AGENTS, LOCAL, readFile } from "./instruction-files.mjs";
import { lintText } from "./instruction-lint.mjs";
import { gateOf } from "./spec/workflow.mjs";

// A regular file under the root (a folder, a missing path or one too odd to stat is not).
function isFile(root, word) {
  const path = resolve(root, word);
  const rel = relative(root, path);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

// The strings that name the gate in a line: each tier's command joined with spaces (the last tier's first),
// and every word of one that is a file under the root, as written and by its basename.
function gateWordsOf(root, spec) {
  const tiers = gateOf(spec)?.tiers ?? [];
  const joined = tiers.map((t) => t.command.join(" ")).reverse();
  const files = tiers.flatMap((t) => t.command).filter((word) => isFile(root, word));
  return [...new Set([...joined, ...files.flatMap((f) => [f, basename(f)])])];
}

export function runLint({ root, spec }, { json }) {
  const names = new Set([AGENTS, "CLAUDE.md", ".claude/CLAUDE.md", LOCAL]);
  if (spec.conductor?.prompt) names.add(spec.conductor.prompt);
  const gateWords = gateWordsOf(root, spec);
  const seen = new Set();
  const files = [];
  const findings = [];
  const out = [];
  for (const name of names) {
    const read = readFile(root, name);
    if (read.error) {
      files.push({ file: name, state: "skipped", why: read.error });
      out.push(`skip: ${name}: ${read.error}`);
      continue;
    }
    if (read.text === null) {
      files.push({ file: name, state: "absent" });
      continue;
    }
    const stat = statSync(join(root, name));
    const id = `${stat.dev}:${stat.ino}`;
    if (seen.has(id)) continue;
    seen.add(id);
    files.push({ file: name, state: "read" });
    const here = lintText(name, read.text, { gateWords });
    findings.push(...here);
    for (const f of here)
      out.push(`! ${f.file}:${f.line}  ${f.rule}  ${f.text}`, `    → ${f.suggest}`);
  }
  const exit = findings.length > 0 ? 1 : 0;
  if (json) return { exit, out: JSON.stringify({ files, findings }) };
  const read = files.filter((f) => f.state === "read").map((f) => f.file);
  const hit = new Set(findings.map((f) => f.file)).size;
  out.push(
    findings.length
      ? `lint: ${findings.length} competing line(s) in ${hit} file(s) · suggest only, nothing written`
      : `lint: no competing lines (${read.join(", ") || "no instruction files"})`,
  );
  return { exit, out: out.join("\n") };
}
