// board instructions [--write] — the Agentry block in `<root>/AGENTS.md` and the `@AGENTS.md` import in
// `<root>/CLAUDE.md` (or `<root>/.claude/CLAUDE.md` as `@../AGENTS.md`, when that is where the repo's
// project instructions live and there is no root one), for `/agentry:init` (plan R1b-8, F18). Without
// `--write` it prints what would change (the block's lines as `-`/`+`) and writes nothing; with it, it
// writes the same. AGENTS.md is created when absent; CLAUDE.md never is, and gets the import only when it
// exists without one. The block comes from the process skill's `templates/agents-block.md`, with the
// process file's `conductor.prompt`. Exit 0, or 2 for markers that don't make one block, a file a symlink
// takes out of the repository or points nowhere, or a file that can't be written. Files are written to
// temporary names first and then renamed in, and a failure puts the first back: never half-done.
//
// run(argv, { root, spec }) -> { exit, out }
import {
  constants,
  accessSync,
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { TEMPLATE, readFile } from "../instruction-files.mjs";
import {
  CLAUDE_DIR_IMPORT,
  IMPORT,
  addImport,
  renderBlock,
  upsertBlock,
} from "../instructions.mjs";

export const usage = "instructions [--write]";
export const flags = { "--write": false };
const SAYS = {
  create: "AGENTS.md: create it with the Agentry block",
  append: "AGENTS.md: append the Agentry block",
  replace: "AGENTS.md: replace the Agentry block",
  unchanged: "AGENTS.md: the Agentry block is up to date",
  absent: "CLAUDE.md: none (not created; Claude Code reads AGENTS.md on its own)",
};
// Where a repo's project instructions can live; the root one wins when both exist.
const CLAUDE = ["CLAUDE.md", ".claude/CLAUDE.md"];

// Same file on disk (a CLAUDE.md that is a link to AGENTS.md must not import itself).
function sameFile(a, b) {
  const sa = statSync(a, { throwIfNoEntry: false });
  const sb = statSync(b, { throwIfNoEntry: false });
  return Boolean(sa && sb && sa.dev === sb.dev && sa.ino === sb.ino);
}

const lines = (mark, text) =>
  text ? text.split(/\r?\n/).map((l) => `${mark} ${l}`.trimEnd()) : [];

// Every file written to a temporary name beside it, then renamed in; a failure leaves all as they were.
function writeAll(root, writes) {
  const staged = [];
  try {
    for (const [name, text] of writes) {
      const file = join(root, name);
      const real = existsSync(file) ? realpathSync(file) : file;
      const was = existsSync(real) ? readFileSync(real) : null;
      if (was) accessSync(real, constants.W_OK);
      const temp = `${real}.agentry-${process.pid}.tmp`;
      writeFileSync(temp, text);
      if (was) chmodSync(temp, statSync(real).mode);
      staged.push({ real, temp, was });
    }
    const renamed = [];
    try {
      for (const w of staged) {
        renameSync(w.temp, w.real);
        renamed.push(w);
      }
    } catch (e) {
      for (const w of renamed) {
        if (w.was) writeFileSync(w.real, w.was);
        else unlinkSync(w.real);
      }
      throw e;
    }
  } finally {
    for (const { temp } of staged) if (existsSync(temp)) unlinkSync(temp);
  }
}

export function run(argv, { root, spec }) {
  const write = argv.includes("--write");
  const prompt = spec.conductor?.prompt;
  const agents = readFile(root, "AGENTS.md");
  const claudeName =
    CLAUDE.find((n) => lstatSync(join(root, n), { throwIfNoEntry: false })) ?? CLAUDE[0];
  const ref = claudeName === CLAUDE[0] ? IMPORT : CLAUDE_DIR_IMPORT;
  const claude = readFile(root, claudeName);
  const failed = agents.error ?? claude.error;
  if (failed) return { exit: 2, out: `✗ ${failed}; nothing written` };
  const block = renderBlock(readFileSync(TEMPLATE, "utf8"), { prompt });
  const up = upsertBlock(agents.text, block);
  if (up.error) return { exit: 2, out: `✗ AGENTS.md: ${up.error}; nothing written` };
  const imp =
    claude.text === null
      ? { action: "absent" }
      : sameFile(join(root, "AGENTS.md"), join(root, claudeName))
        ? { action: "same-file" }
        : addImport(claude.text, ref);
  const out = [SAYS[up.action]];
  if (up.action !== "unchanged") out.push(...lines("-", up.old), ...lines("+", block));
  out.push(
    {
      import: `${claudeName}: add \`${ref}\` as its first line`,
      "has-import": `${claudeName}: already imports AGENTS.md`,
      "same-file": `${claudeName}: the same file as AGENTS.md; no import needed`,
      absent: SAYS.absent,
    }[imp.action],
  );
  if (prompt && !existsSync(join(root, prompt)))
    out.push(`note: the conductor prompt ${prompt} does not exist yet`);
  if (!prompt) out.push("note: no conductor.prompt in the process file; the block names none");
  const writes = [
    up.action !== "unchanged" && ["AGENTS.md", up.text],
    imp.action === "import" && [claudeName, imp.text],
  ].filter(Boolean);
  if (!writes.length) out.push("nothing to write");
  else if (!write) out.push("dry run: nothing written; pass --write to write it");
  else {
    try {
      writeAll(root, writes);
    } catch (e) {
      return { exit: 2, out: `✗ cannot write (${e.code ?? e.message}); nothing written` };
    }
    out.push(`wrote ${writes.map(([name]) => name).join(", ")}`);
  }
  return { exit: 0, out: out.join("\n") };
}
