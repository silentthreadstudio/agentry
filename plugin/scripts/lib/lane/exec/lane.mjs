// exec/lane — what every exec step and domain module shares: the refusal and the stop a step throws
// (`run` makes them exit 2 and 1), the `lane exec` line a step names next, and the reads every step
// starts from: the lane's ledger, its owned files, its flag and its saved reports. They live together
// as the bottom of `exec/`, as `merge/lane.mjs` is of `merge/`: every module above may import them, and
// they import nothing in `exec/`, so no cycle can form through them.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { kindOf } from "../../process/ids.mjs";
import * as ledgers from "../../process/ledger.mjs";
import { flaggedItem } from "../../process/spec/workflow.mjs";
import { laneCommand } from "../commands.mjs";
import { ownedFiles, withNew } from "../owns.mjs";
import { step as advance, expects } from "../rounds.mjs";

export class Refusal extends Error {}
// A step that stopped with nothing written, and says why (exit 1): a gate whose lane moved while it ran.
export class Stopped extends Error {}
export const refuse = (message) => {
  throw new Refusal(message);
};
export const stop = (message) => {
  throw new Stopped(message);
};
export const laneLine = (root, sub, id, extra = "") =>
  laneCommand(`exec ${sub} ${id}`, { root, extra });

export const contractFile = (root, id) => join(ledgers.runDir(root, id), "contract.md");

// A path as `owns` reads it: each leading `./` dropped, `//` collapsed, a trailing `/` dropped. `leaves`
// judges this form, so `.//etc/passwd` is `/etc/passwd`, never `etc/passwd` after the check.
export const normalised = (path) =>
  path
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/(.)\/+$/, "$1") || path;

// Is the item flagged: when the lane started, or on the board now (a flag set since still counts).
export const isFlagged = ({ spec, model }, ledger) =>
  Boolean(ledger.route?.flagged) || flaggedItem(spec, model, ledger.id, kindOf(ledger, spec));

// The owned files every brief names: parsed once at start and kept in the ledger (amended by `owns`).
// A ledger from before that is parsed from its contract file, against its worktree as `start` does.
export const ownedOf = (root, ledger) =>
  ledger.owned ??
  withNew(
    ledger.worktree,
    ownedFiles(readFileSync(contractFile(root, ledger.id), "utf8"), ledger.worktree),
  );

export function mustLedger(root, id) {
  let ledger;
  try {
    ledger = ledgers.read(root, id);
  } catch (e) {
    refuse(e.message);
  }
  if (!ledger) refuse(`no lane for ${id}: run ${laneLine(root, "start", id)}`);
  return ledger;
}

export function readReport(path, who) {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (!text.trim())
    refuse(`no report at ${path}: save the ${who}'s full reply there, then run this step again`);
  return text;
}

// The line to run now, for a refusal to end on: the step the lane expects (a report, verdict, gate, close
// or the owner's resume), or the land when only that is left; "" when nothing can be run.
export function nowLine(root, ledger) {
  const want = expects(ledger);
  if (want === "resume")
    return laneLine(root, "resume", ledger.id, ' --note "<the owner\'s words>"');
  if (want) return laneLine(root, want, ledger.id);
  return ledger.next === "merge" ? `/agentry:merge ${ledger.id}` : "";
}

// ` → <line>` after a refusal that names the step to run instead.
export const thenRun = (root, ledger) => {
  const line = nowLine(root, ledger);
  return line ? ` → ${line}` : "";
};

export function stepWith(ledger, event, root) {
  try {
    return advance(ledger, event);
  } catch (e) {
    return refuse(
      `${e.message} (next is ${ledger.next})${/ expects /.test(e.message) ? thenRun(root, ledger) : ""}`,
    );
  }
}

// Where a builder's report is kept while a guard trip holds the lane: next to it, so the report the
// builder wrote is never needed again.
export const heldCopy = (reportPath) =>
  join(dirname(reportPath), `${basename(reportPath, ".md")}.held.md`);

export const readOr = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

// Is `path` a file (not a directory)?
export const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

// Is there a saved reply at `path`?
export const saved = (path) => {
  try {
    return readFileSync(path, "utf8").trim() !== "";
  } catch {
    return false;
  }
};

// `--from <file>` (`-` is stdin) on report and verdict: the agent's reply copied to the round's report
// path, so the step reads it as it reads one saved there. A report already at the path that differs is
// refused, never overwritten.
export function importReport(from, path) {
  let text;
  try {
    text = readFileSync(from === "-" ? 0 : from, "utf8");
  } catch (e) {
    refuse(`--from ${from === "-" ? "(stdin)" : from} cannot be read: ${e.message}`);
  }
  if (!text.trim()) refuse(`--from ${from === "-" ? "(stdin)" : from} is empty: nothing to save`);
  if (!saved(path)) writeFileSync(path, text);
  else if (readOr(path) !== text)
    refuse(
      `a different report already sits at ${path}: remove it to save this one, or run the step without --from`,
    );
}
