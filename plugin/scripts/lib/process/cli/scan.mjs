// board scan [<dir>] [--json] — every board-like thing in the repository's markdown (plan F13 §2.4),
// the grounding `/agentry:init` learns a process from: each table (file, line, heading, header, row
// count, a first-column sample), the id-led bold leads and headings (contract blocks) and the
// frontmatter docs. `<dir>` (relative to the root) narrows it, and reaches a board under a
// dot-directory, which the whole-repo walk skips. Needs no process file. Writes nothing; exit 0.
//
// run(argv, { root }) -> { exit, out }
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ID_TOKEN, blockStarts, markdownFiles } from "../contract.mjs";
import * as md from "../markdown.mjs";
import { fit } from "../render.mjs";

export const noSpec = true;
const WIDTH = 100;
const SAMPLE = 4;

export function scan(root, dir = "") {
  const base = join(root, dir);
  return markdownFiles(base).flatMap((rel) => {
    const file = dir ? `${dir.replace(/\/$/, "")}/${rel}` : rel;
    let text;
    try {
      text = readFileSync(join(base, rel), "utf8");
    } catch {
      return [];
    }
    const tables = md.tables(text).map((t) => ({
      line: t.line,
      heading: t.heading,
      header: t.header,
      rows: t.rows.length,
      sample: t.rows.slice(0, SAMPLE).map((r) => md.plain(r.cells[t.header[0]])),
    }));
    const starts = blockStarts(text).filter((s) => !s.inline && ID_TOKEN.test(s.id ?? ""));
    const leads = starts.filter((s) => s.type === "bold").map((s) => s.id);
    const headings = starts.filter((s) => s.type === "heading").map((s) => s.id);
    const front = md.frontmatter(text);
    const frontmatter = front ? Object.keys(front.data) : null;
    if (!tables.length && !leads.length && !headings.length && !frontmatter) return [];
    return [{ file, tables, leads, headings, frontmatter }];
  });
}

const ids = (xs) =>
  `${xs.length} (${xs.slice(0, SAMPLE).join(", ")}${xs.length > SAMPLE ? ", …" : ""})`;

function render(found, dir) {
  const count = (f) => found.reduce((n, x) => n + f(x), 0);
  const head = [
    `scan · ${dir || "."} · ${found.length} files`,
    `${count((x) => x.tables.length)} tables`,
    `${count((x) => x.leads.length)} id leads`,
    `${count((x) => x.headings.length)} id headings`,
    `${count((x) => (x.frontmatter ? 1 : 0))} frontmatter docs`,
  ].join(" · ");
  const lines = found.flatMap((x) => [
    "",
    x.file,
    ...x.tables.map(
      (t) =>
        `  table   :${t.line}  ${t.rows} rows  ${t.heading ?? "—"}  [${t.header.join(" | ")}]  ${t.sample.join(", ")}`,
    ),
    ...(x.leads.length ? [`  leads   ${ids(x.leads)}`] : []),
    ...(x.headings.length ? [`  heads   ${ids(x.headings)}`] : []),
    ...(x.frontmatter ? [`  front   ${x.frontmatter.join(", ") || "(empty)"}`] : []),
  ]);
  return [head, ...lines].map((l) => fit(l, WIDTH)).join("\n");
}

export function run(argv, { root }) {
  const dir = argv.find((a) => !a.startsWith("--")) ?? "";
  const found = scan(root, dir);
  return { exit: 0, out: argv.includes("--json") ? JSON.stringify(found) : render(found, dir) };
}
