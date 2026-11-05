// exec/lane — what every exec step and domain module shares: the refusal and the stop a step throws
// (`run` makes them exit 2 and 1), the time and short-sha forms the ledger and the output use, the
// `lane exec` line a step names next, and the reads every step starts from: the lane's ledger, its
// owned files, its flag and its saved reports.
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prefix } from "../../cli/invoke.mjs";
import { kindOf } from "../../process/ids.mjs";
import * as ledgers from "../../process/ledger.mjs";
import { flaggedItem } from "../../process/spec/workflow.mjs";
import { ownedFiles, shellQuote as q, withNew } from "../brief.mjs";
import { step as advance } from "../rounds.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const LANE = join(HERE, "..", "..", "..", "lane.mjs");

export class Refusal extends Error {}
// A step that stopped with nothing written, and says why (exit 1): a gate whose lane moved while it ran.
export class Stopped extends Error {}
export const refuse = (message) => {
  throw new Refusal(message);
};
export const now = () => new Date().toISOString();
export const short = (sha) => String(sha ?? "").slice(0, 7);
export const laneLine = (root, sub, id, extra = "") =>
  `${prefix("lane", `node ${q(LANE)}`)} exec ${sub} ${id} --root ${q(root)}${extra}`;

export const contractFile = (root, id) => join(ledgers.runDir(root, id), "contract.md");

// A parked verified lane (field 63): held with no builder round, its next step kept in the hold.
export const isVerifiedPark = (ledger) =>
  ledger.state === "held" && ledger.hold?.when === "verified";

// A path that leaves the repository: a leading `/` or a `..` segment. `owns` never takes one.
export const leaves = (path) => path.startsWith("/") || path.split("/").includes("..");
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

export function stepWith(ledger, event) {
  try {
    return advance(ledger, event);
  } catch (e) {
    return refuse(`${e.message} (next is ${ledger.next})`);
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
