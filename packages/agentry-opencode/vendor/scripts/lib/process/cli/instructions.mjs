// board instructions [--target agents|local] [--apply] — the Agentry block in `<root>/AGENTS.md` (or, with
// `--target local`, in `<root>/CLAUDE.local.md`, so the block stays out of a public repo) and the `@AGENTS.md`
// import in `<root>/CLAUDE.md` (or `<root>/.claude/CLAUDE.md` as `@../AGENTS.md`, when that is where the
// repo's project instructions live and there is no root one), for `/agentry:init`.
// Without `--apply` it prints what would change (the block's lines as `-`/`+`) and writes nothing; with it,
// it writes the same. The target file is created when absent; CLAUDE.md never is, and gets the import only
// when it exists without one (none for CLAUDE.local.md: Claude Code loads it itself). Without `--target`
// the block stays in the file that holds it, and goes to AGENTS.md when it is in neither; with it, a block
// in the other file moves (removed there, written here, in one all-or-nothing write; files are never
// deleted). The block comes from the process skill's `templates/agents-block.md`, with the workflow file's
// `conductor.prompt`. Exit 0, or 2 for markers that don't make one block, a block in both files, a file a
// symlink takes out of the repository or points nowhere, a file that is not UTF-8 and would have to be
// rewritten, or a file that can't be written. Files are written to temporary names first and then renamed
// in, and a failure puts the first back: never half-done.
//
// `--lint` reads instead (`../instructions-lint.mjs`): the lines that compete with the block. Never writes.
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
import { dirname, join } from "node:path";
import { PREVIEW, refuse, usageError } from "../../cli/help.mjs";
import { sweepTemps, tempOf } from "../../fs/atomic.mjs";
import {
  AGENTS,
  LOCAL,
  TEMPLATE,
  localCaveat,
  locateBlock,
  readFile,
  sameFile,
} from "../instruction-files.mjs";
import { runLint } from "../instructions-lint.mjs";
import {
  CLAUDE_DIR_IMPORT,
  IMPORT,
  addImport,
  removeBlock,
  renderBlock,
  upsertBlock,
} from "../instructions.mjs";

export const help = {
  usage: "instructions [--target agents|local] [--apply] [--json] | instructions --lint [--json]",
  purpose:
    "The Agentry block in AGENTS.md (or CLAUDE.local.md) and the @AGENTS.md import in CLAUDE.md: what would change; --lint: the lines that compete with it.",
  args: {},
  flags: {
    "--apply": "write the files, or none",
    "--target <agents|local>": "where the block goes: AGENTS.md (default) or CLAUDE.local.md",
    "--lint":
      "list the instruction-file lines that compete with the block; suggests, writes nothing",
    "--json": "print the plan (or the lint) as one JSON object",
  },
  exits: {
    0: "printed (and written with --apply); with --lint, no competing line",
    1: "--lint found a competing line",
    2: "markers that don't make one block, a block in both files, a file out of the repository or not UTF-8, a failed write, or a bad flag",
  },
  example: "board instructions --target local --apply",
};
const TARGETS = { agents: AGENTS, local: LOCAL };
const what = "board instructions";
const SAYS = {
  create: "create it with the Agentry block",
  append: "append the Agentry block",
  replace: "replace the Agentry block",
  unchanged: "the Agentry block is up to date",
};
const ABSENT = "CLAUDE.md: none (not created; Claude Code reads AGENTS.md on its own)";
// Where a repo's project instructions can live; the root one wins when both exist.
const CLAUDE = ["CLAUDE.md", ".claude/CLAUDE.md"];

const lines = (mark, text) =>
  text ? text.split(/\r?\n/).map((l) => `${mark} ${l}`.trimEnd()) : [];

// argv → { lint, write, json, target } or { error }; `target` is a key of TARGETS, or undefined.
function parse(argv) {
  const at = argv.indexOf("--target");
  const value = argv[at + 1];
  const [lint, write, json] = ["--lint", "--apply", "--json"].map((s) => argv.includes(s));
  if (lint && (write || at >= 0))
    return { error: "--lint only reads; it takes no --apply or --target" };
  if (at < 0) return { lint, write, json };
  if (value === undefined || value.startsWith("--")) return { error: "--target needs a value" };
  if (argv.indexOf("--target", at + 1) >= 0) return { error: "--target is given twice" };
  if (!Object.hasOwn(TARGETS, value))
    return { error: `--target takes ${Object.keys(TARGETS).join(" or ")}, not "${value}"` };
  return { lint, write, json, target: value };
}

// Every file written to a temporary name beside it (`fs/atomic.mjs`'s), then renamed in; a failure leaves
// all as they were. Returns how many leftover temporary files of a killed write it removed first.
function writeAll(root, writes) {
  const staged = [];
  let leftovers = 0;
  try {
    for (const [name, text] of writes) {
      const file = join(root, name);
      const real = existsSync(file) ? realpathSync(file) : file;
      const was = existsSync(real) ? readFileSync(real) : null;
      if (was) accessSync(real, constants.W_OK);
      leftovers += sweepTemps(dirname(real)).length;
      const temp = tempOf(real);
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
  return leftovers;
}

export function run(argv, { root, spec }) {
  const { lint, write, json, target, error } = parse(argv);
  if (error) return usageError(what, error);
  if (lint) return runLint({ root, spec }, { json });
  const prompt = spec.conductor?.prompt;
  const located = locateBlock(root);
  const claudeName =
    CLAUDE.find((n) => lstatSync(join(root, n), { throwIfNoEntry: false })) ?? CLAUDE[0];
  const ref = claudeName === CLAUDE[0] ? IMPORT : CLAUDE_DIR_IMPORT;
  const claude = readFile(root, claudeName);
  const failed = located.error ?? claude.error;
  if (failed) return refuse(what, `${failed}; nothing written`);
  // One file under both names: the block lives in AGENTS.md, whatever the target.
  const single = !(LOCAL in located.files);
  const goes = single ? "agents" : (target ?? (located.at === LOCAL ? "local" : "agents"));
  const dest = TARGETS[goes];
  const other = dest === AGENTS ? LOCAL : AGENTS;
  const block = renderBlock(readFileSync(TEMPLATE, "utf8"), { prompt });
  const up = upsertBlock(located.files[dest].text, block);
  if (up.error) return refuse(dest, `${up.error}; nothing written`);
  const out = [`${dest}: ${SAYS[up.action]}`];
  if (up.action !== "unchanged") out.push(...lines("-", up.old), ...lines("+", block));
  // The block in the other file moves: taken out of it here, written to `dest` below.
  const rm = !single && located.at === other ? removeBlock(located.files[other].text) : null;
  if (rm?.error) return refuse(other, `${rm.error}; nothing written`);
  if (rm) out.push(`${other}: remove the Agentry block (it moves to ${dest})`);
  const imp =
    goes === "local"
      ? { action: "not-needed" }
      : claude.text === null
        ? { action: "absent" }
        : sameFile(join(root, AGENTS), join(root, claudeName))
          ? { action: "same-file" }
          : addImport(claude.text, ref);
  out.push(
    {
      import: `${claudeName}: add \`${ref}\` as its first line`,
      "has-import": `${claudeName}: already imports AGENTS.md`,
      "same-file": `${claudeName}: the same file as AGENTS.md; no import needed`,
      "not-needed": `${claudeName}: no import needed (the block is in ${LOCAL})`,
      absent: ABSENT,
    }[imp.action],
  );
  if (prompt && !existsSync(join(root, prompt)))
    out.push(`note: the conductor prompt ${prompt} does not exist yet`);
  if (!prompt) out.push("note: no conductor.prompt in the workflow file; the block names none");
  if (
    rm &&
    goes === "local" &&
    claude.text !== null &&
    addImport(claude.text, ref).action === "has-import"
  )
    out.push(
      `note: ${claudeName} still imports AGENTS.md; drop the import by hand if AGENTS.md held only the block`,
    );
  const caveat = dest === LOCAL ? localCaveat(root) : null;
  if (caveat === "tracked")
    out.push(`note: ${LOCAL} is tracked by git; the block would be committed`);
  if (caveat === "not-ignored")
    out.push(`note: git does not ignore ${LOCAL} → echo ${LOCAL} >> .gitignore`);
  // The removal first: a stop between the two writes leaves the block nowhere, never in both files.
  const writes = [
    rm && [other, rm.text],
    up.action !== "unchanged" && [dest, up.text],
    imp.action === "import" && [claudeName, imp.text],
  ].filter(Boolean);
  const lossy = writes
    .map(([name]) => name)
    .find((name) => (name === claudeName ? claude : located.files[name]).lossy);
  if (lossy) return refuse(what, `${lossy} is not UTF-8 text; nothing written`);
  if (!writes.length) out.push("nothing to write");
  else if (!write) out.push(PREVIEW);
  else {
    let leftovers;
    try {
      leftovers = writeAll(root, writes);
    } catch (e) {
      return refuse(what, `cannot write (${e.code ?? e.message}); nothing written`);
    }
    out.push(
      `wrote ${writes.map(([name]) => name).join(", ")}${leftovers ? " (removed a leftover temp file)" : ""}`,
    );
  }
  if (json) {
    const files = writes.map(([name]) => name);
    const action = (name) => (name === dest ? up.action : name === other && rm ? "remove" : "none");
    const data = {
      target: goes,
      agents: action(AGENTS),
      local: action(LOCAL),
      claude: { file: claudeName, action: imp.action },
      files,
      applied: write && files.length > 0,
      lines: out,
    };
    return { exit: 0, out: JSON.stringify(data) };
  }
  return { exit: 0, out: out.join("\n") };
}
