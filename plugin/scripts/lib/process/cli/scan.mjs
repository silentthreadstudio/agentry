// board scan [<dir>] [--json] — every board-like thing in the repository's markdown (plan F13 §2.4),
// the grounding `/agentry:init` learns a process from: each table (file, line, heading, header, row
// count, a first-column sample), the id-led bold leads and headings (contract blocks) and the
// frontmatter docs. The whole repository means its git-tracked `*.md` (every one on disk, outside
// dot-directories, when git cannot answer). `<dir>` (relative to the root) narrows it to that directory
// as it is on disk, so it reaches an untracked board or one under a dot-directory. Needs no process
// file. A file a symlink takes out of the repository is listed as skipped, never read. Writes
// nothing. With no `<dir>`, a last line names the git-ignored directories holding markdown it did not
// read (`not scanned (ignored): .docs (44 md) → agentry board scan .docs/…`). Exit 0, or 2 for a `<dir>` outside the repository (as written or through a symlink).
//
// run(argv, { root }) -> { exit, out }
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { refuse } from "../../cli/help.mjs";
import { nextStep } from "../../cli/invoke.mjs";
import { ID_TOKEN, blockStarts, markdownFiles, repoMarkdown } from "../contract.mjs";
import * as md from "../markdown.mjs";
import { staysInside } from "../read.mjs";
import { fit } from "../render.mjs";
import { escapesRoot } from "../spec.mjs";

export const noSpec = true;
export const help = {
  usage: "scan [<dir>] [--json]",
  purpose: "Every board-like table, id-led block and frontmatter doc in the repo's markdown.",
  args: { "<dir>": "narrow it to one directory (relative to the root), as it is on disk" },
  flags: { "--json": "print the files found as one JSON array" },
  exits: { 0: "printed", 2: "usage, or a <dir> outside the repository" },
  example: "board scan docs/work --json",
};
const WIDTH = 100;
const SAMPLE = 4;
const HIDDEN_LISTED = 3;
const OUTSIDE = "a symlink out of the repository; not read";

export function scan(root, dir = "") {
  const base = join(root, dir);
  const files = dir ? markdownFiles(base) : repoMarkdown(root, "**/*.md");
  return files.flatMap((rel) => {
    const file = dir ? `${dir.replace(/\/$/, "")}/${rel}` : rel;
    if (!staysInside(root, join(base, rel))) return [{ file, skipped: OUTSIDE }];
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

// The git-ignored directories that hold markdown a whole-repo scan did not read: `{ dir, md }`, the one
// with the most markdown first. Build and dependency folders, tool folders and Agentry's own run state are
// not boards, so they are left out.
const NOT_BOARDS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".agentry",
  ".claude",
  ".agents",
  ".venv",
  "venv",
]);
export function ignoredDirs(root) {
  let out;
  try {
    out = execFileSync(
      "git",
      ["-C", root, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return [];
  }
  return out
    .split("\0")
    .filter((p) => p.endsWith("/") && !p.split("/").some((seg) => NOT_BOARDS.has(seg)))
    .map((p) => p.slice(0, -1))
    .map((dir) => ({ dir, md: markdownFiles(join(root, dir)).length }))
    .filter((x) => x.md > 0)
    .sort((a, b) => b.md - a.md || a.dir.localeCompare(b.dir));
}

function render(all, dir, ignored) {
  const found = all.filter((x) => !x.skipped);
  const skipped = all.filter((x) => x.skipped);
  const count = (f) => found.reduce((n, x) => n + f(x), 0);
  const head = [
    `scan · ${dir || "."} · ${found.length} files`,
    `${count((x) => x.tables.length)} tables`,
    `${count((x) => x.leads.length)} id leads`,
    `${count((x) => x.headings.length)} id headings`,
    `${count((x) => (x.frontmatter ? 1 : 0))} frontmatter docs`,
    ...(skipped.length ? [`${skipped.length} skipped`] : []),
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
  const notes = skipped.flatMap((x) => ["", x.file, `  skipped ${x.skipped}`]);
  // The biggest folders first, the rest counted; the arrow points at the biggest.
  const shown = ignored.slice(0, HIDDEN_LISTED).map((x) => `${x.dir} (${x.md} md)`);
  const more = ignored.length > HIDDEN_LISTED ? [`+${ignored.length - HIDDEN_LISTED} more`] : [];
  const hidden = ignored.length
    ? [
        "",
        nextStep(
          `not scanned (ignored): ${[...shown, ...more].join(", ")} → board scan ${ignored[0].dir}/…`,
        ),
      ]
    : [];
  return [head, ...lines, ...notes, ...hidden].map((l) => fit(l, WIDTH)).join("\n");
}

export function run(argv, { root }) {
  const dir = argv.find((a) => !a.startsWith("--")) ?? "";
  if (escapesRoot(".", dir) || !staysInside(root, join(root, dir)))
    return refuse("board scan", `"${dir}" leaves the repository`, "board scan");
  const found = scan(root, dir);
  if (argv.includes("--json")) return { exit: 0, out: JSON.stringify(found) };
  return { exit: 0, out: render(found, dir, dir ? [] : ignoredDirs(root)) };
}
