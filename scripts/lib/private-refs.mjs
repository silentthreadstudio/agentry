// private-refs — comments in shipped files must stand on their own. The repo is public, and a comment that
// cites a design doc, an ADR, an acceptance-criterion number, a field number, an owner-call id or a task id
// points at something a reader cannot open. Say the reason in a clause, or drop the citation.
//
// privateRefs(rootDir) -> string[]   "<file>:<line>: comment cites a private reference (<match>)" each,
// over the comments of every code file under `plugin/` and `packages/`. Strings are never read: a printed
// message or a test name that holds an id is the program's own text, not a comment.
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
    String.raw`\bautopilot-design\b`,
    String.raw`\breshape plan\b`,
    String.raw`\b(?:Plan|Spec) v2\b`,
  ].join("|"),
);

const CODE = /\.(?:mjs|js|ts|astro|css|html)$/;
const YAML = /\.ya?ml$/;
const SKIP_DIR = new Set(["node_modules", "dist", ".astro", ".git"]);
// The memory server bundle is built output: its comments are its dependencies', not this repo's.
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

export function privateRefs(rootDir) {
  const problems = [];
  for (const top of ["plugin", "packages"]) {
    let files;
    try {
      files = walk(join(rootDir, top));
    } catch {
      continue;
    }
    for (const file of files) {
      const rel = relative(rootDir, file);
      if (BUILT.test(rel) || !(CODE.test(file) || YAML.test(file))) continue;
      const text = readFileSync(file, "utf8");
      for (const [line, comment] of CODE.test(file) ? codeComments(text) : yamlComments(text)) {
        const hit = PRIVATE_REF.exec(comment);
        if (hit)
          problems.push(`${rel}:${line}: comment cites a private reference (${hit[0].trim()})`);
      }
    }
  }
  return problems;
}
