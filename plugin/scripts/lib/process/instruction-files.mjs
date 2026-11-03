// instruction-files — where the Agentry block comes from and how a repo's instruction file is read for
// it: the process skill's `templates/agents-block.md`, and `AGENTS.md` / `CLAUDE.md` / `CLAUDE.local.md`
// read only while they stay inside the repository. Shared by `board instructions` (which writes), its
// `--lint` and `board explain`'s lanes (which only report).
//
// TEMPLATE                                  the block's template file
// AGENTS, LOCAL                             the two files the block can live in
// readFile(root, name) -> { text } | { text: null } | { error }   `lossy: true` when the bytes are not UTF-8
// sameFile(a, b) -> boolean                 both exist and are one file on disk (a link included)
// locateBlock(root) -> { at, files } | { error }   `at` is the file holding the block (null when none);
//   `files` is `{ [name]: { text, lossy? } }` for AGENTS.md and CLAUDE.local.md, the second left out when
//   it is the same file as the first; a block in both is an `error`
// localCaveat(root) -> "tracked" | "not-ignored" | null    why a block in CLAUDE.local.md would leak
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_ROOT } from "./default-agent.mjs";
import { trackedFiles } from "./git.mjs";
import { hasBlock } from "./instructions.mjs";
import { staysInside } from "./read.mjs";

export const TEMPLATE = join(PLUGIN_ROOT, "skills", "process", "templates", "agents-block.md");
export const AGENTS = "AGENTS.md";
export const LOCAL = "CLAUDE.local.md";

/** The file's text, null when absent, or the reason it can't be used. Bytes that are not UTF-8 read as
 *  U+FFFD, and the result says `lossy: true`: fit to lint, never to write back. */
export function readFile(root, name) {
  const file = join(root, name);
  if (!staysInside(root, file)) return { error: `${name} is a symlink out of the repository` };
  // A write would follow a broken symlink to wherever it points.
  if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() && !existsSync(file))
    return { error: `${name} is a broken symlink` };
  if (!existsSync(file)) return { text: null };
  try {
    const bytes = readFileSync(file);
    const text = bytes.toString("utf8");
    return Buffer.from(text, "utf8").equals(bytes) ? { text } : { text, lossy: true };
  } catch (e) {
    return { error: `cannot read ${name} (${e.code ?? e.message})` };
  }
}

export function sameFile(a, b) {
  const sa = statSync(a, { throwIfNoEntry: false });
  const sb = statSync(b, { throwIfNoEntry: false });
  return Boolean(sa && sb && sa.dev === sb.dev && sa.ino === sb.ino);
}

export function locateBlock(root) {
  const agents = readFile(root, "AGENTS.md");
  const local = readFile(root, LOCAL);
  const failed = agents.error ?? local.error;
  if (failed) return { error: failed };
  const one = sameFile(join(root, AGENTS), join(root, LOCAL));
  const files = { [AGENTS]: agents, ...(one ? {} : { [LOCAL]: local }) };
  const holding = Object.keys(files).filter(
    (name) => files[name].text !== null && hasBlock(files[name].text),
  );
  if (holding.length > 1)
    return { error: `${AGENTS} and ${LOCAL} both hold an Agentry block; remove one by hand` };
  return { at: holding[0] ?? null, files };
}

/** Why a block in CLAUDE.local.md would reach the repo's history: git tracks the file, or does not
 *  ignore it. Null when neither (or when `root` is no git work tree). Tracked wins over not ignored. */
export function localCaveat(root) {
  const tracked = trackedFiles(root, LOCAL);
  if (tracked === null) return null;
  if (tracked.length > 0) return "tracked";
  try {
    execFileSync("git", ["-C", root, "check-ignore", "-q", "--", LOCAL], { stdio: "ignore" });
    return null;
  } catch {
    return "not-ignored";
  }
}
