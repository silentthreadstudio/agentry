// merge/recover — what a killed land leaves, dealt with before anything else on the rerun (plan R1b-5).
// A land writes what it is about to do to the ledger before it does it; this step reads that intent
// against main and either finishes what the killed run did or puts main back where the rerun can start.
// It acts only on what it can prove is its own: board writes and a board commit by the sha256 the record
// stored before writing (`merge.record`), a cherry-pick by the planned commits git names. Anything else
// stops the land, left as it is, with the commands that clear it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../carry-io.mjs";
import { endStrayGate } from "../gate-group.mjs";
import {
  abortPick,
  commitOf,
  commitsBetween,
  filesOf,
  pickInProgress,
  resolvedByHand,
  restoreFiles,
  sequencerTodo,
  subjectOf,
  textAt,
} from "../land.mjs";
import { rollBack } from "./gating.mjs";
import { afterLand, now, ok, red, save, setMerge, short } from "./lane.mjs";

const readText = (root, file) => {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    return null;
  }
};

// The record's files a killed run left written: `mine`, where the index and the working copy each hold
// HEAD's text or the text the record wrote (and not both HEAD's), and `foreign`, where either holds
// anything else.
function writesLeft({ root, ledger }) {
  const record = ledger.merge.record ?? { files: [], sha256: {} };
  const mine = [];
  const foreign = [];
  for (const file of record.files) {
    const head = textAt(root, "HEAD", file);
    const copies = [textAt(root, "", file), readText(root, file)];
    const known = (text) =>
      text !== null && (text === head || sha256(text) === record.sha256[file]);
    if (!copies.every(known)) foreign.push(file);
    else if (copies.some((text) => text !== head)) mine.push(file);
  }
  return { mine, foreign };
}

// Why commit `sha` is not provably this land's board commit, or null when it is: it changes exactly the
// files the record names, each to the text the record wrote.
function notOurCommit({ root, ledger }, sha) {
  const record = ledger.merge.record;
  if (!record?.files.length) return "the ledger holds no record of the land's board writes";
  const files = filesOf(root, sha) ?? [];
  const extra = files.filter((file) => !record.files.includes(file));
  if (extra.length > 0) return `it also changes ${extra.slice(0, 5).join(", ")}`;
  const differ = record.files.filter((file) => {
    const text = textAt(root, sha, file);
    return text === null || sha256(text) !== record.sha256[file];
  });
  if (differ.length > 0) return `${differ.join(", ")} in it is not what the land wrote`;
  return null;
}

// What a run killed at `recording` left on main: `{ moved }` (main is not on the picks), `{ commit,
// later, why }` (a commit past the picks: this land's board commit when `why` is null), or `{ mine,
// foreign }` (main at the picks: the board writes left in the record's files).
function recordingLeft(lane) {
  const merge = lane.ledger.merge;
  const chain = commitsBetween(lane.root, merge.preHead, "HEAD", { firstParent: true }) ?? [];
  const n = merge.landed.length;
  if (chain.length < n || chain.slice(0, n).join(" ") !== merge.landed.join(" "))
    return { moved: true };
  if (chain.length > n) {
    const [commit, ...later] = chain.slice(n);
    return { commit, later, why: notOurCommit(lane, commit) };
  }
  return writesLeft(lane);
}

const restoreCmd = (files) => `git restore --source=HEAD --staged --worktree -- ${files.join(" ")}`;

// A run killed while it wrote or committed the board (`step: "recording"`). Its board commit on main,
// proven by the record: the land is done, and the ledger says so now. Main still at the picks: its own
// writes are taken back and the land resumes from its green gate. Anything it cannot prove is its own
// stops the land, untouched.
function resumeRecording(lane, rows) {
  const { root } = lane;
  const left = recordingLeft(lane);
  if (left.moved) return null; // the land step says main has moved
  if (left.commit) return recordedCommit(lane, rows, left);
  if (left.foreign.length > 0) {
    rows.push(
      red("recover", "a killed land was writing the board, and a file it wrote changed since", [
        ...left.foreign.map((file) => `${file}: neither HEAD's text nor what the land wrote`),
        "nothing is taken back or written",
      ]),
    );
    const files = left.foreign.join(" ");
    return {
      exit: 1,
      keepCarry: true,
      next: `in ${root}: git diff HEAD -- ${files} shows the land's writes and the edit since; save that edit, then ${restoreCmd(left.foreign)} and land again (it writes the board again)`,
    };
  }
  if (left.mine.length > 0) {
    const back = restoreFiles(root, left.mine);
    if (!back.ok) {
      rows.push(red("recover", `cannot take back a killed run's board writes: ${back.reason}`));
      return { exit: 1, keepCarry: true, next: `show the owner git status in ${root}` };
    }
    rows.push(
      ok("recover", "took back the board writes a killed run left uncommitted", [
        `${left.mine.join(", ")}: back at HEAD; the land writes them again`,
      ]),
    );
  }
  setMerge(lane, { step: "gated", record: undefined });
  return null;
}

// The commit right after the picks, when a run was killed at `recording`.
function recordedCommit(lane, rows, { commit, later, why }) {
  const { root } = lane;
  const { mainBranch } = lane.ledger;
  const merge = lane.ledger.merge;
  const after = later.map(
    (sha) => `${short(sha)} ${subjectOf(root, sha)}: after it, not this land's`,
  );
  if (why) {
    rows.push(
      red(
        "recover",
        `${short(commit)} ${subjectOf(root, commit)}, right after the picks, is not provably this land's board commit: ${why}`,
        after,
      ),
    );
    const moved = `show the owner git log --first-parent ${short(merge.preHead)}..${mainBranch}: main moved under the land`;
    const next =
      later.length > 0
        ? moved
        : `in ${root}: git show --stat ${short(commit)}. If it is this land's board commit (a hook changed it): git reset --keep ${short(commit)}~1, then land again (it writes and commits the board again). If it is not: ${moved}`;
    return { exit: 1, keepCarry: true, next };
  }
  // The record's files, carried writes included, are in that commit as written: the ledger lets go.
  save(lane, {
    state: "merged",
    merge: {
      ...merge,
      carry: undefined,
      record: undefined,
      step: "committed",
      boardCommit: commit,
      at: now(),
    },
  });
  rows.push(
    ok(
      "recover",
      `a killed run had made the board commit: ${short(commit)} ${subjectOf(root, commit)}`,
      ["the land is done: nothing is picked, gated or committed again", ...after],
    ),
  );
  return { exit: 0, next: afterLand(lane) };
}

// Why the cherry-pick (or revert) git is in the middle of is not provably this land's, or null when it
// is: the ledger says it was picking, git is not reverting, what git stopped on is a planned commit, the
// sequencer has only planned commits left to pick, and no resolution was staged by hand.
function notOwnPick({ root, ledger }, busy) {
  const merge = ledger.merge;
  const names = busy.map((b) => b.name);
  if (names.includes("REVERT_HEAD")) return "git is reverting";
  if (merge?.step !== "picking") return "this land was not picking";
  const planned = new Set(merge.planned);
  const at = commitOf(root, "CHERRY_PICK_HEAD");
  if (names.includes("CHERRY_PICK_HEAD") && !planned.has(at))
    return `it stopped on ${at ? short(at) : "a commit git cannot name"}, not a planned pick`;
  const todo = sequencerTodo(root);
  const stray = todo?.find((t) => t.command !== "pick" || !planned.has(t.sha));
  if (stray) return `its sequencer still has "${stray.command} ${stray.word}", not a planned pick`;
  if (!at && !todo?.length) return "git names no planned commit it was picking";
  if (resolvedByHand(root)) return "a resolution staged by hand";
  return null;
}

const pickKind = (busy) => (busy.some((b) => b.name === "REVERT_HEAD") ? "revert" : "cherry-pick");

/** The preflight's view of what a killed land left: the recover row, the files main's row leaves to the
 *  land (its own board writes), and whether main's row is left out (git mid-pick in the land's own). */
export function recoverPreview(lane) {
  const busy = pickInProgress(lane.root);
  if (busy.length > 0) {
    const why = notOwnPick(lane, busy);
    const row = why
      ? red(
          "recover",
          `git is in the middle of a ${pickKind(busy)} that is not this land's: ${why}`,
        )
      : ok("recover", "a killed land left a cherry-pick: the land clears it");
    return { row, ignore: [], skipMain: !why };
  }
  if (lane.ledger.merge?.step !== "recording") return { row: null, ignore: [], skipMain: false };
  const left = recordingLeft(lane);
  if (left.moved)
    return {
      row: red("recover", "a killed land was writing the board, and main has moved since"),
      ignore: [],
      skipMain: false,
    };
  if (left.commit)
    return {
      row: left.why
        ? red(
            "recover",
            `${short(left.commit)} after the picks is not provably this land's board commit: ${left.why}`,
          )
        : ok(
            "recover",
            `a killed land made its board commit ${short(left.commit)}: the land records it`,
          ),
      ignore: [],
      skipMain: false,
    };
  if (left.foreign.length > 0)
    return {
      row: red(
        "recover",
        "a killed land was writing the board, and a file it wrote changed since",
        left.foreign,
      ),
      ignore: left.mine,
      skipMain: false,
    };
  return {
    row: ok("recover", "a killed land was writing the board: the land clears it", left.mine),
    ignore: left.mine,
    skipMain: false,
  };
}

// git mid-cherry-pick in the main checkout. This land's own is aborted, as the pick step aborts any
// stop of its own; the land step then takes off whatever picks the abort left. Any other is not
// merge's to end: it is left as it is.
function endOwnPick(lane, rows, busy) {
  const { root } = lane;
  const why = notOwnPick(lane, busy);
  const ended = why ? null : abortPick(root);
  if (ended?.ok) {
    const times = ended.aborts > 1 ? ` (${ended.aborts} aborts)` : "";
    rows.push(ok("recover", `aborted the cherry-pick a killed run left${times}`));
    return null;
  }
  const kind = pickKind(busy);
  rows.push(
    red(
      "recover",
      why
        ? `git is in the middle of a ${kind} that is not this land's: ${why}`
        : `git is in the middle of this land's cherry-pick, and the abort did not end it: ${ended.reason}`,
      busy.map((b) => b.path),
    ),
  );
  return {
    exit: 1,
    keepCarry: true,
    next: why
      ? `in ${root}: finish or abort it (git ${kind} --continue, or git ${kind} --abort), then land again; merge leaves it alone`
      : `in ${root}: finish or abort it (git cherry-pick --abort, again while git status still names one), then land again`,
  };
}

/** A killed land leaves its gate's process group, maybe still running; git, maybe in the middle of the
 *  cherry-pick; a board write, a board commit or a rollback's reset the ledger does not know of yet.
 *  The rerun deals with each before anything else. */
export function recoverStep(lane, rows) {
  const merge = lane.ledger.merge;
  if (merge?.gateRun) {
    const res = endStrayGate(merge.gateRun);
    if (!res.ok) {
      rows.push(red("recover", `the gate a killed run started is still running: ${res.reason}`));
      return {
        exit: 1,
        keepCarry: true,
        next: `stop process group ${res.pgid} (kill -KILL -- -${res.pgid}), then land again`,
      };
    }
    setMerge(lane, { gateRun: undefined, ...(merge.step === "gating" && { step: "landed" }) });
    if (res.killed)
      rows.push(
        ok("recover", `stopped the gate a killed run left running (process group ${res.pgid})`),
      );
  }
  const busy = pickInProgress(lane.root);
  if (busy.length > 0) {
    const stop = endOwnPick(lane, rows, busy);
    if (stop) return stop;
  }
  const step = lane.ledger.merge?.step;
  if (step === "recording") return resumeRecording(lane, rows);
  if (step === "rolling-back") {
    rows.push(ok("recover", "finishing the rollback a killed run started after its red gate"));
    return rollBack(lane, rows);
  }
  return null;
}
