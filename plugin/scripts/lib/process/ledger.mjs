// ledger — a lane task's state on disk: `<main root>/.agentry/run/process/ledger/<id>.json` (shape pinned
// in the R1b plan §3.1), with its run files (briefs, reports, gate logs) in `…/process/runs/<id>/`.
//
// Every path hangs off the MAIN checkout's root, never a worktree's, so a step run from inside a worktree
// reads and writes the same ledger. Writes are atomic (temp file, then rename). Along with `drafts`, this is
// the only `.agentry/run` I/O of the process kit. Node built-ins only.
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VERSION = 1;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const validId = (id) => typeof id === "string" && ID.test(id) && !id.includes("..");

const processDir = (root) => join(root, ".agentry", "run", "process");
const ledgerDir = (root) => join(processDir(root), "ledger");
const fileOf = (root, id) => join(ledgerDir(root), `${id}.json`);

/** The ledger for `id`, or null when there is none. Throws when the file is there but unusable. */
export function read(root, id) {
  if (!validId(id)) return null;
  let text;
  try {
    text = readFileSync(fileOf(root, id), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  let ledger;
  try {
    ledger = JSON.parse(text);
  } catch (err) {
    throw new Error(`ledger ${fileOf(root, id)} is not valid JSON: ${err.message}`);
  }
  if (ledger?.v !== VERSION || ledger.id !== id)
    throw new Error(`ledger ${fileOf(root, id)} is not a v${VERSION} ledger for "${id}"`);
  return ledger;
}

/** Write `ledger` (stamping `updatedAt`) atomically; returns what was written. Throws on a bad id/version. */
export function write(root, ledger) {
  if (!validId(ledger?.id)) throw new Error(`ledger id "${ledger?.id}" is not a plain id`);
  if (ledger.v !== VERSION) throw new Error(`ledger "${ledger.id}" must have v: ${VERSION}`);
  const out = { ...ledger, updatedAt: new Date().toISOString() };
  const file = fileOf(root, ledger.id);
  mkdirSync(ledgerDir(root), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
  renameSync(tmp, file);
  return out;
}

/** Every readable ledger, by id. A file that does not parse is left out (a nudge reading the board must not
 *  die on one bad ledger); `read` is the call that names the problem. */
export function list(root) {
  let names;
  try {
    names = readdirSync(ledgerDir(root));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    try {
      const ledger = read(root, name.slice(0, -".json".length));
      if (ledger) out.push(ledger);
    } catch {
      /* unusable ledger: skipped here, reported by `read` */
    }
  }
  return out;
}

/** The task's run directory (briefs, reports, gate logs), created if missing. */
export function runDir(root, id) {
  if (!validId(id)) throw new Error(`ledger id "${id}" is not a plain id`);
  const dir = join(processDir(root), "runs", id);
  mkdirSync(dir, { recursive: true });
  return dir;
}
