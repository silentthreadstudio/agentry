// ledger — a lane task's state on disk: `<main root>/.agentry/run/process/ledger/<id>.json` (shape pinned),
// with its run files (briefs, reports, gate logs) in `…/process/runs/<id>/`. A
// restart's archive of them is `ledger/.archive/<id>.<n>.json` and `runs/.archive/<id>.<n>/`: an id opens
// with a letter or a digit, so no id's ledger or run dir reaches a dot directory. Older restarts kept them
// flat as `ledger/<id>.<n>.json` and `runs/<id>.<n>/`, names the valid id `<id>.<n>` reaches too: such a
// ledger file, the ledger of the id before the dot, is read as that archive, never as a ledger, and moves
// under `.archive/` when the id it names writes its own ledger. (`ledger/archive/`, a layout no release
// wrote, reads as an archive too.)
//
// Every path hangs off the MAIN checkout's root, never a worktree's, so a step run from inside a worktree
// reads and writes the same ledger. Writes are atomic (temp file, then rename), and every read first sweeps
// the temp files a killed writer left (`fs/atomic.mjs`). The ledger layout is this file's; other
// modules also keep files under `.agentry/run` (`drafts`, `board-writes`, `stale-status`, `spikes`). Node
// built-ins only.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, sweepTemps } from "../fs/atomic.mjs";
import { idProblem } from "../id.mjs";

const VERSION = 1;
const validId = (id) => idProblem(id) === null;

const sameWord = (a, b) => a.toLowerCase() === b.toLowerCase();

/** The temp files the writes before `fs/atomic.mjs` left (`<id>.json.<pid>.tmp`, this module's and
 *  restack's): swept like the atomic helper's own. */
export const OLD_TEMP = /^.+\.json\.(\d+)\.tmp$/;

const processDir = (root) => join(root, ".agentry", "run", "process");
const ledgerDir = (root) => join(processDir(root), "ledger");
const runsDir = (root) => join(processDir(root), "runs");
const archiveDir = (root) => join(ledgerDir(root), ".archive");
const runsArchiveDir = (root) => join(runsDir(root), ".archive");
const fileOf = (root, id) => join(ledgerDir(root), `${id}.json`);
const names = (dir) => {
  try {
    return readdirSync(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
};

// The JSON in `file`, or undefined when there is no such file. Throws when it does not parse.
function parsed(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return undefined;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`ledger ${file} is not valid JSON: ${err.message}`);
  }
}

// `{ id, n }` when `data`, read from `<name>.json` in the ledger directory, is an older restart's flat
// archive: the ledger of another id, `name` being that id, a dot and a number. Else null.
function flatArchive(name, data) {
  const id = data?.id;
  if (typeof id !== "string" || !name.startsWith(`${id}.`)) return null;
  const n = name.slice(id.length + 1);
  return /^\d+$/.test(n) ? { id, n: Number(n) } : null;
}

// What `<id>.json` holds: `{ ledger }`, or `{ not }` saying why it holds no ledger of `id` (no file,
// another id's archive, another id's ledger on a case-insensitive filesystem). Throws when it is unusable.
function load(root, id) {
  const file = fileOf(root, id);
  const data = parsed(file);
  if (data === undefined) return { not: "gone" };
  const archived = flatArchive(id, data);
  if (archived) return { not: `an archive of ${archived.id} (restart ${archived.n})` };
  // On a case-insensitive filesystem `t-1` opens `T-1.json`: that is another task's ledger, not ours.
  if (typeof data?.id === "string" && data.id !== id && sameWord(data.id, id))
    return { not: `the ledger of ${data.id}` };
  if (data?.v !== VERSION || data.id !== id)
    throw new Error(`ledger ${file} is not a v${VERSION} ledger for "${id}"`);
  return { ledger: data };
}

/** The ledger for `id`, or null when there is none (an older restart's archive under its name is none).
 *  Throws when the file is there but unusable. The dead writers' temp files are swept first, unless
 *  `sweep` is false (a preview that must change nothing). */
export function read(root, id, { sweep = true } = {}) {
  if (!validId(id)) return null;
  if (sweep) sweepTemps(ledgerDir(root), OLD_TEMP);
  return load(root, id).ledger ?? null;
}

/** Write `ledger` (stamping `updatedAt`) atomically; returns what was written. Throws on a bad id/version. */
export function write(root, ledger) {
  if (!validId(ledger?.id)) throw new Error(`ledger id "${ledger?.id}" is not a plain id`);
  if (ledger.v !== VERSION) throw new Error(`ledger "${ledger.id}" must have v: ${VERSION}`);
  const out = { ...ledger, updatedAt: new Date().toISOString() };
  const file = fileOf(root, ledger.id);
  mkdirSync(ledgerDir(root), { recursive: true });
  // Two ids that differ only by case would share one file on a case-insensitive filesystem.
  const twin = readdirSync(ledgerDir(root))
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -".json".length))
    .find((n) => n !== ledger.id && sameWord(n, ledger.id));
  if (twin) throw new Error(`ledger id "${ledger.id}" differs only by case from "${twin}"`);
  moveFlatArchive(root, ledger.id);
  atomicWrite(file, `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

// An older restart's flat archive at `id`'s ledger path goes under `.archive/` before `id` writes there:
// never overwritten, never lost.
function moveFlatArchive(root, id) {
  let data;
  try {
    data = parsed(fileOf(root, id));
  } catch {
    return; // not JSON, so no archive: the write replaces it as it would any unusable ledger
  }
  if (!flatArchive(id, data)) return;
  const to = join(archiveDir(root), `${id}.json`);
  if (existsSync(to)) throw new Error(`ledger ${fileOf(root, id)} is an archive, and ${to} exists`);
  mkdirSync(archiveDir(root), { recursive: true });
  renameSync(fileOf(root, id), to);
}

/** Every readable ledger, by id. A file that holds none is left out (a nudge reading the board must not
 *  die on one bad ledger) and named in the array's `skipped`: `[{ file, why }]`, an older restart's
 *  archive among them. */
export function list(root, { sweep = true } = {}) {
  if (sweep) sweepTemps(ledgerDir(root), OLD_TEMP);
  const out = [];
  const skipped = [];
  for (const name of names(ledgerDir(root))
    .filter((n) => n.endsWith(".json"))
    .sort()) {
    const id = name.slice(0, -".json".length);
    const file = join(ledgerDir(root), name);
    if (!validId(id)) {
      skipped.push({ file, why: `"${id}" is not a plain id` });
      continue;
    }
    try {
      const got = load(root, id);
      if (got.ledger) out.push(got.ledger);
      else if (got.not !== "gone") skipped.push({ file, why: got.not });
    } catch (err) {
      skipped.push({ file, why: err.message });
    }
  }
  return Object.defineProperty(out, "skipped", { value: skipped });
}

/** Lane `id`'s archives, by number: `{ n, file, runs }`. `file` is the archived ledger: each
 *  `ledger/.archive/<id>.<n>.json`, `ledger/archive/<id>.<n>.json` and older restart's flat
 *  `ledger/<id>.<n>.json` that holds `id`'s ledger; null for a `runs/.archive/<id>.<n>/` with none (an
 *  archive cut short). `runs` is its run dir: `runs/.archive/<id>.<n>/`, else an older restart's flat
 *  `runs/<id>.<n>/`, else null. */
export function archives(root, id) {
  const numberOf = (name, ext = ".json") => {
    const n = name.slice(id.length + 1, name.length - ext.length);
    return name.startsWith(`${id}.`) && name.endsWith(ext) && /^\d+$/.test(n) ? Number(n) : null;
  };
  // A flat one is `id`'s only when it holds `id`'s ledger: else it is the ledger of the id it names.
  const holdsId = (file, name) => {
    try {
      return flatArchive(name.slice(0, -".json".length), parsed(file))?.id === id;
    } catch {
      return false; // not JSON: no archive of anything
    }
  };
  const files = new Map();
  for (const [dir, flat] of [
    [archiveDir(root), false],
    [join(ledgerDir(root), "archive"), false],
    [ledgerDir(root), true],
  ])
    for (const name of names(dir)) {
      const n = numberOf(name);
      const file = join(dir, name);
      if (n !== null && !files.has(n) && (!flat || holdsId(file, name))) files.set(n, file);
    }
  for (const name of names(runsArchiveDir(root))) {
    const n = numberOf(name, "");
    if (n !== null && !files.has(n)) files.set(n, null);
  }
  const runsOf = (n) =>
    [join(runsArchiveDir(root), `${id}.${n}`), join(runsDir(root), `${id}.${n}`)].find((dir) =>
      existsSync(dir),
    ) ?? null;
  return [...files].map(([n, file]) => ({ n, file, runs: runsOf(n) })).sort((a, b) => a.n - b.n);
}

/** Archive lane `id` as number `n`: its ledger moved to `ledger/.archive/<id>.<n>.json`, its run dir to
 *  `runs/.archive/<id>.<n>/` (made empty when it has none). `{ runs, ledger }`, the archived paths.
 *  Throws when an archive `n` of `id` exists in any layout (never overwritten). */
export function archive(root, id, n) {
  if (!validId(id)) throw new Error(`ledger id "${id}" is not a plain id`);
  const ledger = join(archiveDir(root), `${id}.${n}.json`);
  const runs = join(runsArchiveDir(root), `${id}.${n}`);
  if (archives(root, id).some((a) => a.n === n)) throw new Error(`an archive ${id}.${n} exists`);
  const from = join(runsDir(root), id);
  mkdirSync(runsArchiveDir(root), { recursive: true });
  if (existsSync(from)) renameSync(from, runs);
  else mkdirSync(runs);
  mkdirSync(archiveDir(root), { recursive: true });
  renameSync(fileOf(root, id), ledger);
  return { runs, ledger };
}

/** The task's run directory (briefs, reports, gate logs), created if missing. */
export function runDir(root, id) {
  if (!validId(id)) throw new Error(`ledger id "${id}" is not a plain id`);
  const dir = join(runsDir(root), id);
  mkdirSync(dir, { recursive: true });
  return dir;
}
