// private-refs — comments in shipped files must stand on their own. The repo is public, and a comment that
// cites a design doc, an ADR, an acceptance-criterion number, a field number, an owner-call id or a task id
// points at something a reader cannot open. Say the reason in a clause, or drop the citation. The same holds for
// the prose of the shipped markdown (agents, commands, skills and their references): a model and its reader get
// only what the file says.
//
// privateRefs(rootDir) -> string[]   "<file>:<line>: comment cites a private reference (<match>)" each,
// over the comments of every code file under `plugin/`, `packages/` and `scripts/`, and "<file>:<line>: prose
// cites a private reference (<match>)" over every line of the markdown under `plugin/`, code fences included
// (examples ship too). Strings are never read: a printed message or a test name that holds an id is the
// program's own text, not a comment.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

// What a private citation looks like. Each alternative is a form real comments used; each is tight enough
// to leave `SHA-256`, `T-1` in a usage example, `A/A` and "Field 22 of /proc/<pid>/stat" alone.
export const PRIVATE_REF = new RegExp(
  [
    String.raw`\bADR-\w+`, // ADR-001, ADR-R1
    String.raw`\bdocs? \d{2}\b`, // doc 07
    "§", // a section of some document
    String.raw`\bAC-?\d+\b`, // AC4, AC-4
    String.raw`\bA\d{2}\b`, // A45: an owner-call id
    String.raw`\bT-\d{2,}\b`, // T-10, T-003: a task id
    String.raw`\bfield #?\d+\b`, // field 84
    String.raw`\bF\d{2}\b`, // F13
    String.raw`\bR1[a-z]-\d+`, // R1d-38: a triage or task id
    String.raw`\bS\d{2}\b`, // S46
    String.raw`\b[Dd]ecisions? \d+\b(?![\w-])`, // decision 51
    String.raw`\bplan (?:R1\w*|F\d+)`, // plan R1b, plan F13
    String.raw`\bR1[a-z] plan\b`,
    String.raw`\.docs/`, // the private design folder
    String.raw`\bautopilot-design\b`,
    String.raw`\breshape plan\b`,
    String.raw`\b(?:Plan|Spec) v2\b`,
  ].join("|"),
);

// The same for markdown prose. Tighter than PRIVATE_REF: `AC1..n` (the Spec's own criteria ids), `T-1` and `T-014`
// (placeholder task ids in examples), a `§` that points at another section of the shipped files, and `ADR-worthy`
// are the plugin's own words, so none of them is a citation here.
export const PRIVATE_REF_PROSE = new RegExp(
  [
    String.raw`\bADR-\d+`, // ADR-001
    String.raw`\bdoc[ -]\d{2}\b`, // doc 07, doc-01
    String.raw`\bA\d{2}\b`, // A45: an owner-call id
    String.raw`\b[Ff]ield #?\d+\b`, // field 84
    String.raw`(?<![\w&/])#\d{2,}\b`, // #97: a field report or issue number (not #L42, not &#10;)
    String.raw`\bR1[a-z]-\d+`, // R1d-27: a task id
    String.raw`\bS\d{2}\b`, // S46: a triage id
    String.raw`\b[Dd]ecisions? \d+\b(?![\w-])`, // decision 51
    String.raw`\bplan (?:R1\w*|F\d+)`,
    String.raw`\bR1[a-z] plan\b`,
    String.raw`\.docs/`,
    String.raw`\bautopilot-design\b`,
    String.raw`\breshape plan\b`,
    String.raw`\b(?:Plan|Spec) v2\b`,
  ].join("|"),
);

const CODE = /\.(?:mjs|js|ts|astro|css|html)$/;
const YAML = /\.ya?ml$/;
const MARKDOWN = /^plugin\/.*\.md$/;
const SKIP_DIR = new Set(["node_modules", "dist", ".astro", ".git"]);
// The memory server bundle is built output: its comments are its dependencies', not this repo's.
// This check's own file and test name the patterns they look for.
const SELF = /^scripts\/(?:lib\/private-refs\.mjs|private-refs\.test\.mjs)$/;
const BUILT = /(?:^|\/)mem\/index\.js$/;

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (SKIP_DIR.has(e.name) ? [] : walk(join(dir, e.name))) : [join(dir, e.name)],
  );

// The comment part of each line of a code file as [lineNumber, text]: a `//` outside a string and after
// whitespace (so `https://` is not one), and the lines of a `/* … */` block.
function codeComments(text) {
  const out = [];
  let inBlock = false;
  text.split("\n").forEach((line, i) => {
    let comment = "";
    if (inBlock) {
      const end = line.indexOf("*/");
      comment = end < 0 ? line : line.slice(0, end);
      if (end >= 0) inBlock = false;
    } else {
      let quote = null;
      for (let k = 0; k < line.length; k++) {
        const ch = line[k];
        if (quote) {
          if (ch === "\\") k++;
          else if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
        else if (ch === "/" && line[k + 1] === "/" && (k === 0 || /\s/.test(line[k - 1]))) {
          comment = line.slice(k);
          break;
        } else if (ch === "/" && line[k + 1] === "*") {
          const end = line.indexOf("*/", k + 2);
          comment = end < 0 ? line.slice(k) : line.slice(k, end);
          inBlock = end < 0;
          break;
        }
      }
    }
    if (comment) out.push([i + 1, comment]);
  });
  return out;
}

// A YAML comment: a `#` at the start of a line or after whitespace, outside quotes.
function yamlComments(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    const hit = /(?:^|\s)#(.*)$/.exec(
      line.replace(/(["'])(?:\\.|(?!\1).)*\1/g, (m) => " ".repeat(m.length)),
    );
    if (hit) out.push([i + 1, hit[1]]);
  });
  return out;
}

// The files git tracks under `top` (absolute paths): ignored output such as eval results is not shipped, so it is
// not checked. Outside a git work tree (a copy of the repo) every file under `top` is.
function shipped(rootDir, top) {
  try {
    const out = execFileSync("git", ["-C", rootDir, "ls-files", "-z", "--", top], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\0")
      .filter(Boolean)
      .map((rel) => join(rootDir, rel));
  } catch {
    try {
      return walk(join(rootDir, top));
    } catch {
      return [];
    }
  }
}

export function privateRefs(rootDir) {
  const problems = [];
  for (const top of ["plugin", "packages", "scripts"]) {
    const files = shipped(rootDir, top);
    for (const file of files) {
      const rel = relative(rootDir, file);
      if (SELF.test(rel) || BUILT.test(rel)) continue;
      const prose = MARKDOWN.test(rel);
      if (!prose && !(CODE.test(file) || YAML.test(file))) continue;
      // A tracked file the disk no longer has (a parked package's entry, a dangling symlink): the
      // absence itself is the finding, named like any other — never an uncaught ENOENT mid-check.
      // Any other read failure is not this one's finding: it keeps throwing.
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        problems.push(
          `${rel}: git tracks it, but the file is absent → restore the file or drop it from the index`,
        );
        continue;
      }
      if (prose) {
        text.split("\n").forEach((line, i) => {
          const hit = PRIVATE_REF_PROSE.exec(line);
          if (hit) problems.push(`${rel}:${i + 1}: prose cites a private reference (${hit[0]})`);
        });
        continue;
      }
      for (const [line, comment] of CODE.test(file) ? codeComments(text) : yamlComments(text)) {
        const hit = PRIVATE_REF.exec(comment);
        if (hit)
          problems.push(`${rel}:${line}: comment cites a private reference (${hit[0].trim()})`);
      }
    }
  }
  return problems;
}
