// board instructions [--write] — the Agentry block in `<root>/AGENTS.md` and the `@AGENTS.md` import in
// `<root>/CLAUDE.md`, for `/agentry:init` (plan R1b-8, F18). Without `--write` it prints what would
// change (the block's lines as `-`/`+`) and writes nothing; with it, it writes the same. AGENTS.md is
// created when absent; CLAUDE.md never is, and gets the import only when it exists without one. The
// block comes from the process skill's `templates/agents-block.md`, with the process file's
// `conductor.prompt`. Exit 0, or 2 for markers that don't make one block or a file a symlink takes out
// of the repository or points nowhere (nothing written).
//
// run(argv, { root, spec }) -> { exit, out }
import { existsSync, lstatSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addImport, renderBlock, upsertBlock } from "../instructions.mjs";
import { staysInside } from "../read.mjs";

export const usage = "instructions [--write]";
export const flags = { "--write": false };
// cli/ → process/ → lib/ → scripts/ → the plugin root.
const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const TEMPLATE = join(PLUGIN, "skills", "process", "templates", "agents-block.md");
const SAYS = {
  create: "AGENTS.md: create it with the Agentry block",
  append: "AGENTS.md: append the Agentry block",
  replace: "AGENTS.md: replace the Agentry block",
  unchanged: "AGENTS.md: the Agentry block is up to date",
  import: "CLAUDE.md: add `@AGENTS.md` as its first line",
  "has-import": "CLAUDE.md: already imports AGENTS.md",
  absent: "CLAUDE.md: none (not created; Claude Code reads AGENTS.md on its own)",
  "same-file": "CLAUDE.md: the same file as AGENTS.md; no import needed",
};

// Same file on disk (a CLAUDE.md that is a link to AGENTS.md must not import itself).
function sameFile(a, b) {
  const sa = statSync(a, { throwIfNoEntry: false });
  const sb = statSync(b, { throwIfNoEntry: false });
  return Boolean(sa && sb && sa.dev === sb.dev && sa.ino === sb.ino);
}

// The file's text, null when absent, or the reason it can't be used.
function readFile(root, name) {
  const file = join(root, name);
  if (!staysInside(root, file)) return { error: `${name} is a symlink out of the repository` };
  // A write would follow a broken symlink to wherever it points.
  if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() && !existsSync(file))
    return { error: `${name} is a broken symlink` };
  if (!existsSync(file)) return { text: null };
  try {
    return { text: readFileSync(file, "utf8") };
  } catch (e) {
    return { error: `cannot read ${name} (${e.code ?? e.message})` };
  }
}

const lines = (mark, text) =>
  text ? text.split(/\r?\n/).map((l) => `${mark} ${l}`.trimEnd()) : [];

export function run(argv, { root, spec }) {
  const write = argv.includes("--write");
  const prompt = spec.conductor?.prompt;
  const agents = readFile(root, "AGENTS.md");
  const claude = readFile(root, "CLAUDE.md");
  const failed = agents.error ?? claude.error;
  if (failed) return { exit: 2, out: `✗ ${failed}; nothing written` };
  const block = renderBlock(readFileSync(TEMPLATE, "utf8"), { prompt });
  const up = upsertBlock(agents.text, block);
  if (up.error) return { exit: 2, out: `✗ AGENTS.md: ${up.error}; nothing written` };
  const imp =
    claude.text === null
      ? { action: "absent" }
      : sameFile(join(root, "AGENTS.md"), join(root, "CLAUDE.md"))
        ? { action: "same-file" }
        : addImport(claude.text);
  const out = [SAYS[up.action]];
  if (up.action !== "unchanged") out.push(...lines("-", up.old), ...lines("+", block));
  out.push(SAYS[imp.action]);
  if (prompt && !existsSync(join(root, prompt)))
    out.push(`note: the conductor prompt ${prompt} does not exist yet`);
  if (!prompt) out.push("note: no conductor.prompt in the process file; the block names none");
  const writes = [
    up.action !== "unchanged" && ["AGENTS.md", up.text],
    imp.action === "import" && ["CLAUDE.md", imp.text],
  ].filter(Boolean);
  if (!writes.length) out.push("nothing to write");
  else if (!write) out.push("dry run: nothing written; pass --write to write it");
  else {
    for (const [name, text] of writes) writeFileSync(join(root, name), text);
    out.push(`wrote ${writes.map(([name]) => name).join(", ")}`);
  }
  return { exit: 0, out: out.join("\n") };
}
