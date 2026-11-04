// merge/recover — what a killed land leaves, dealt with before anything else on the rerun (plan R1b-5).
// A land writes what it is about to do to the ledger before it does it; this step reads that intent
// against main and either finishes what the killed run did or puts main back where the rerun can start.
// It acts only on what it can prove is its own: board writes and a board commit by the sha256 the record
// stored before writing (`merge.record`), a cherry-pick by the planned commits git names. Anything else
// stops the land, left as it is, with the commands that clear it. A land that cannot go on at all is
// closed on the owner's call (`--resolve landed|rolled-back`, field 82), checked against main first.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { identities } from "../../process/git.mjs";
import { list as listLedgers, read as readLedger } from "../../process/ledger.mjs";
import { sha256 } from "../carry-io.mjs";
import { endStrayGate } from "../gate-group.mjs";
import {
  abortPick,
  commitOf,
  commitsBetween,
  filesOf,
  isAncestor,
  pickInProgress,
  resolvedByHand,
  restoreFiles,
  sequencerTodo,
  subjectOf,
  textAt,
} from "../land.mjs";
import { isMemoryCommit } from "../own-memory.mjs";
import { childrenOf } from "../stack.mjs";
import { git } from "../worktree.mjs";
import { backStop, putBackAllow, releaseWrites } from "./carry.mjs";
import { rollBack } from "./gating.mjs";
import { afterLand, done, landNext, now, ok, red, save, setMerge, short, warn } from "./lane.mjs";

const readText = (root, file) => {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    return null;
  }
};

// The record's files a killed run left written: `mine` (files), where the index and the working copy
// each hold HEAD's text or the text the record wrote (and not both HEAD's), and `foreign` (`{ file,
// where }`), where either holds anything else: `where` names which, "staged", "working copy" or both.
function writesLeft({ root, ledger }) {
  const record = ledger.merge.record ?? { files: [], sha256: {} };
  const mine = [];
  const foreign = [];
  for (const file of record.files) {
    const head = textAt(root, "HEAD", file);
    const copies = { staged: textAt(root, "", file), "working copy": readText(root, file) };
    // The text the record wrote, or (a recorded board write put back for the record) the text it wrote on.
    const known = (text) =>
      text !== null &&
      (text === head ||
        sha256(text) === record.sha256[file] ||
        sha256(text) === record.base?.[file]);
    const odd = Object.keys(copies).filter((copy) => !known(copies[copy]));
    if (odd.length > 0) foreign.push({ file, where: odd.join(" and ") });
    else if (Object.values(copies).some((text) => text !== head)) mine.push(file);
  }
  return { mine, foreign };
}
const foreignLine = ({ file, where }) =>
  `${file}: ${where} holds neither HEAD's text nor what the land wrote`;

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
// foreign }` (main at the picks: the board writes left in the record's files). A commit that only adds
// Agentry's memory records (the owner committing an episode) is not past the picks: it is no one's
// board commit, and the land goes on on top of it. Nor is one the land accepted after its gate before it
// wrote the board (the owner's board fix, field 79): the record names the commit it wrote on (`on`).
function recordingLeft(lane) {
  const { root } = lane;
  const merge = lane.ledger.merge;
  const chain = commitsBetween(root, merge.preHead, "HEAD", { firstParent: true }) ?? [];
  const n = merge.landed.length;
  if (chain.length < n || chain.slice(0, n).join(" ") !== merge.landed.join(" "))
    return { moved: true };
  const on = merge.record?.on;
  const from = on ? chain.indexOf(on) + 1 : n;
  if (from === 0 || from < n) return { moved: true }; // the commit it wrote on is gone, or is a pick
  const past = chain.slice(from).filter((sha) => !isMemoryCommit(root, sha));
  if (past.length > 0) {
    const [commit, ...later] = past;
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
        ...left.foreign.map(foreignLine),
        "nothing is taken back or written",
      ]),
    );
    const files = left.foreign.map((f) => f.file);
    const paths = files.join(" ");
    // Both copies, each against HEAD: an edit only staged does not show in the working copy's diff,
    // and the restore below takes both.
    return {
      exit: 1,
      keepCarry: true,
      next: `in ${root}: git diff --cached HEAD -- ${paths} (staged) and git diff HEAD -- ${paths} (working copy) each show the land's writes and the edit since; save the edit from both, then ${restoreCmd(files)} and land again (it writes the board again)`,
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
  // The recorded board writes are in that commit when the record wrote on them (its `base` names each
  // file; a record from before they were carried does not, and they go back uncommitted). The owner's
  // set-aside files go back first: a record from an older version stops here, with the ledger still
  // recording, so the rerun (and its --drop-carry) gets here again.
  const writes = merge.writes?.files ?? [];
  if (writes.length > 0 && writes.every((file) => merge.record?.base?.[file])) releaseWrites(lane);
  const back = putBackAllow(lane);
  if (back) rows.push(back);
  const stop = backStop(lane, back);
  if (stop) return stop;
  // The record's files, carried writes included, are in that commit as written: the ledger lets go.
  save(lane, {
    state: "merged",
    merge: {
      ...lane.ledger.merge,
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
        left.foreign.map(foreignLine),
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

// --- --resolve: the owner closes a stuck land -------------------------------------------------------

const RESOLUTIONS = ["landed", "rolled-back"];
const FULL_SHA = /^[0-9a-f]{40}$/;
const listOf = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
// What a land sets aside of main and holds in the ledger: closing the ledger over it would lose it.
const HELD = ["carry", "allow", "writes"];

// The record's files whose staged or working copy is not HEAD's.
function recordFilesLeft(root, merge) {
  const files = Array.isArray(merge.record?.files) ? merge.record.files : [];
  return files.filter((file) => {
    const head = textAt(root, "HEAD", file);
    return readText(root, file) !== head || textAt(root, "", file) !== head;
  });
}

// Why `landed` cannot be said of `merge`, or null: every recorded pick is on main.
function notLanded(root, merge) {
  const landed = Array.isArray(merge.landed) ? merge.landed : [];
  if (landed.length === 0) return "the ledger records no landed pick: not landed";
  const off = landed.find((sha) => !isAncestor(root, sha, "HEAD"));
  return off ? `${short(off)} is not on main: not landed` : null;
}

// The stable patch id of each non-merge commit `revs` (git log arguments) lists: `{ ids: [{ patchId, sha }]
// }`, or `{ error }` when git cannot say. A commit that changes nothing has none.
function patchIdsOf(root, revs) {
  const flags = revs.filter((r) => r.startsWith("--"));
  const refs = revs.filter((r) => !r.startsWith("--"));
  const log = git(root, [
    "log",
    "-p",
    "--no-color",
    "--no-ext-diff",
    "--no-merges",
    ...flags,
    "--end-of-options",
    ...refs,
    "--",
  ]);
  if (log.status !== 0) return { error: log.stderr.trim().split("\n")[0] || "git log failed" };
  if (!log.stdout.trim()) return { ids: [] };
  const res = git(root, ["patch-id", "--stable"], log.stdout);
  if (res.status !== 0) return { error: res.stderr.trim().split("\n")[0] || "git patch-id failed" };
  const ids = res.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [patchId, sha] = line.split(" ");
      return { patchId, sha };
    });
  return { ids };
}

// Why `rolled-back` cannot be said of `merge`, or null. A planned commit is on main when any of these
// holds: it, or a recorded pick, is an ancestor of HEAD (the owner merged the branch); a commit since
// preHead, any parent and any place, has its identity (author, date and message, which a cherry-pick keeps
// even when the owner resolved its conflict by hand); a first-parent commit since preHead has its patch.
// When git cannot tell, that is the answer: never "none".
function notRolledBack(root, merge) {
  // A revert leaves the pick on main: the way on is the other resolution, and the board record by hand.
  const onMain = (sha) =>
    `${short(sha)} is on main: not rolled back → if you reverted it, the picks are still on main: --resolve landed, then record the board by hand`;
  const cannotTell = (why) => `cannot tell whether a pick is on main (${why}): not rolled back`;
  const landed = Array.isArray(merge.landed) ? merge.landed : [];
  const planned = Array.isArray(merge.planned) ? merge.planned : [];
  const ancestor = [...landed, ...planned].find((sha) => isAncestor(root, sha, "HEAD"));
  if (ancestor) return onMain(ancestor);
  if (planned.length === 0) return null;
  if (typeof merge.preHead !== "string")
    return "the ledger names no preHead: cannot tell what is on main";
  const since = git(root, [
    "rev-list",
    "--reverse",
    "--end-of-options",
    `${merge.preHead}..HEAD`,
    "--",
  ]);
  if (since.status !== 0)
    return cannotTell(since.stderr.trim().split("\n")[0] || "git rev-list failed");
  const commits = since.stdout.split("\n").filter(Boolean);
  const ids = identities(root, [...planned, ...commits]);
  const unread = [...planned, ...commits].find((sha) => !ids.has(sha));
  if (unread) return cannotTell(`git cannot read ${short(unread)}'s author, date and message`);
  const wanted = new Set(planned.map((sha) => ids.get(sha)));
  const same = commits.find((sha) => wanted.has(ids.get(sha)));
  if (same) return onMain(same);
  const mine = patchIdsOf(root, ["--no-walk=unsorted", ...planned]);
  const main = mine.error
    ? mine
    : patchIdsOf(root, ["--reverse", "--first-parent", `${merge.preHead}..HEAD`]);
  const error = mine.error ?? main.error;
  if (error) return cannotTell(error);
  const picks = new Set(mine.ids.map((p) => p.patchId));
  const on = main.ids.find((p) => picks.has(p.patchId));
  return on ? onMain(on.sha) : null;
}

/** `lane merge <id> --resolve landed|rolled-back`: on the owner's call, close a ledger in `merging` a land
 *  cannot finish. `landed`: every recorded pick is on main; the ledger is `merged` with the picks as its
 *  commits and no board commit (the board record is the owner's). `rolled-back`: no pick is on main; the
 *  ledger's `merge` goes and the lane is `verified` again. Each checks main first and refuses with what it
 *  found; neither touches main or the board, and the ledger is written once. */
export function resolveMode(lane) {
  const { root, id, opts } = lane;
  const as = opts["--resolve"];
  if (!RESOLUTIONS.includes(as))
    return done(2, lane, [red("resolve", `--resolve takes landed or rolled-back, not "${as}"`)]);
  let ledger;
  try {
    ledger = readLedger(root, id);
  } catch (error) {
    return done(2, lane, [red("resolve", error.message)]);
  }
  if (!ledger) return done(2, lane, [red("resolve", `no ledger for ${id}`)]);
  lane.ledger = ledger;
  const no = (why) => done(2, lane, [red("resolve", why)]); // no next: the ledger is not written
  if (ledger.state !== "merging")
    return no(`${id}'s lane is "${ledger.state}": --resolve closes only a land in "merging"`);
  const merge = ledger.merge ?? {};
  // The ledger's commits go to git as revisions: each must be a full SHA, before any git call.
  const named = [merge.preHead, ...listOf(merge.planned), ...listOf(merge.landed)];
  const bad = named.find((v) => v !== undefined && !(typeof v === "string" && FULL_SHA.test(v)));
  if (bad !== undefined)
    return no(
      `ledger value ${typeof bad === "string" ? bad : JSON.stringify(bad)} is not a commit sha: not ${as === "landed" ? "landed" : "rolled back"}`,
    );
  if (pickInProgress(root).length > 0)
    return no(`git is in the middle of a cherry-pick in ${root}: finish or abort it first`);
  const held = HELD.filter((key) => merge[key]);
  if (held.length > 0)
    return no(
      `the ledger still holds what the land set aside (merge.${held.join(", merge.")}): land again to put it back first (${landNext(id)})`,
    );
  // A land killed while it wrote the board: its own writes still on main are the land's to finish or take
  // back, which a closed ledger (no record) could no longer prove.
  const unrecorded = merge.step === "recording" ? recordFilesLeft(root, merge) : [];
  if (unrecorded.length > 0)
    return no(
      `${unrecorded.join(", ")} hold this land's board writes, uncommitted: rerun lane merge ${id} to finish the record, or put them back first`,
    );
  const why = as === "landed" ? notLanded(root, merge) : notRolledBack(root, merge);
  if (why) return no(why);
  if (as === "landed") {
    const n = merge.landed.length;
    const resolved = { as, at: now() };
    const merged = {
      state: "merged",
      merge: {
        ...merge,
        record: undefined,
        gateRun: undefined,
        step: "committed",
        boardCommit: null,
        resolved,
        at: now(),
      },
    };
    lane.ledger = { ...ledger, ...merged };
    const next = afterLand(lane);
    save(lane, { ...merged, next });
    const detail = `resolved: ${n} pick(s) on main; ledger merged (the board record is yours: board set … and the handoff line)`;
    const picks = merge.landed.map((sha) => `${short(sha)} ${subjectOf(root, sha)}`);
    // No board commit, so no restack of the lanes stacked on this one: each is named with its command.
    const kids = childrenOf(listLedgers(root), id).map((child) =>
      warn("stack", `${child} is stacked on ${id}: agentry lane exec restack ${child} --main`),
    );
    return done(0, lane, [ok("resolve", detail, picks), ...kids], next);
  }
  const next = landNext(id);
  save(lane, { state: "verified", merge: undefined, next });
  return done(
    0,
    lane,
    [ok("resolve", "resolved: no pick on main; merge cleared, the lane is verified again")],
    next,
  );
}
