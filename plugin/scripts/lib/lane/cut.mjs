// cut — `lane exec cut <id>` (field 95): retire a lane on the owner's decision, landing only the paths the
// owner keeps. Every check comes first and writes nothing, so a preview (no `--apply`) is the same answer
// with nothing written. With `--apply` and `--keep`, the kept paths' content at the lane's tip becomes one
// commit made off main (a throwaway index on main's HEAD, so main's checkout is never touched to build it),
// landed by the land's own steps: main's row and the carry of exec's writes (`merge/carry.mjs`), the
// cherry-pick and what main holds after it (`land.mjs`), the merge role's gate tier on those paths and the
// rollback on red (`merge/gating.mjs`). Once the commit is gated its land record leaves the ledger, so the
// other lanes' guards judge it as any commit on main (decision 51: only an overlap with their files trips)
// and drift never reads it as a land. Then, as the land's record and commit steps do, exec's carried
// writes and the owner's recorded board writes go back on the board with the lifecycle's `cut` word, and
// one board commit holds them (`land.mjs`'s `boardCommit`, `chore(board): cut <id> (<D>)`), so main is
// clean for the next land; the owner's guard.allow edits go back after it. The ledger records `cut` and is
// closed, the worktree is removed (its uncommitted work saved) and the branch is kept as
// `agentry/<id>.cut`, by ref at its listed tip. `cli/exec.mjs` parses the call.
//
// cutLane(ctx, id, { ledger, refuse, stop, laneLine }) -> { exit, out }   `out` the step's JSON
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { PREVIEW } from "../cli/help.mjs";
import { branchTips } from "../process/git.mjs";
import * as ledgers from "../process/ledger.mjs";
import { applyEvent } from "../process/lifecycle.mjs";
import { readProcess } from "../process/read.mjs";
import { escapesRoot, own } from "../process/spec/shape.mjs";
import { gateOf, lifecycleOf } from "../process/spec/workflow.mjs";
import { WriteError } from "../process/write.mjs";
import { resolveBranch, shellWord } from "./adopt.mjs";
import { decisionKind } from "./brief.mjs";
import { putCells } from "./carry-io.mjs";
import { changedSince, pickTier } from "./gate.mjs";
import {
  attributionIn,
  boardCommit,
  cherryPick,
  commitOf,
  landedSince,
  mergeBaseOf,
  restoreFiles,
  textAt,
} from "./land.mjs";
import {
  carryBackStep,
  carryWritesStep,
  giveBack,
  mainRow,
  mainStep,
  putBackAllow,
  releaseWrites,
  takeCarryStep,
} from "./merge/carry.mjs";
import { gateStep, rollBack } from "./merge/gating.mjs";
import { now, ok, save, setMerge, warn } from "./merge/lane.mjs";
import { gatingNow } from "./restack.mjs";
import { leftover, saveWork } from "./restart.mjs";
import { expects } from "./rounds.mjs";
import { checkCommits, rulesOf } from "./subjects.mjs";
import { branchOf, git, porcelain, remove } from "./worktree.mjs";

const short = (sha) => String(sha ?? "").slice(0, 7);
const first = (text) => String(text).trim().split("\n")[0] ?? "";
const MARK = { ok: "✓", warn: "!", red: "✗", skip: "·", wait: "…" };
const SHOWN = 5;
const listed = (items) =>
  items.slice(0, SHOWN).join(", ") +
  (items.length > SHOWN ? ` (+${items.length - SHOWN} more)` : "");

// The land's step rows as lines, as `lane merge` prints them.
const rowLines = (rows) =>
  rows.flatMap((r) => [`${MARK[r.mark]} ${r.step} ${r.detail}`, ...r.more.map((m) => `  ${m}`)]);

/** The default subject: `chore(<scope>): keep <n> files from <id>`, the scope the first folder every kept
 *  file shares, else the id in lower case. */
export function defaultMessage(id, files) {
  const tops = new Set(files.map((f) => (f.includes("/") ? f.split("/")[0] : null)));
  const [top] = tops;
  const scope = tops.size === 1 && top ? top : id.toLowerCase();
  return `chore(${scope}): keep ${files.length} files from ${id}`;
}

/** The files of `changed` (the branch's) that the `--keep` value names: each comma-separated path is a
 *  file the branch changes or a folder holding some. `{ files }` or `{ problem }`. Pure. */
export function keptFiles(value, changed) {
  const files = new Set();
  for (const given of value.split(",").map((p) => p.trim())) {
    const path = posix.normalize(given.replace(/^(?:\.\/)+/, "")).replace(/\/+$/, "");
    if (!given || path === "." || path === "")
      return { problem: `--keep takes comma-separated paths, no blanks: "${given}"` };
    if (escapesRoot(".", path)) return { problem: `--keep: ${given} leaves the repository` };
    const hits = changed.filter((f) => f === path || f.startsWith(`${path}/`));
    if (!hits.length) return { problem: `--keep: the branch does not change ${given}` };
    for (const f of hits) files.add(f);
  }
  return { files: [...files].sort() };
}

// Git on `root` against a throwaway index (`env`): its stdout, or a throw with git's own words.
function indexGit(root, env, args, input) {
  const res = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
  });
  if (res.status !== 0) throw new Error(`git ${args[0]}: ${first(res.stderr) || "failed"}`);
  return res.stdout;
}

/** The commit that lands the kept files: main's HEAD with each of `files` as `tip` holds it (gone when the
 *  tip has no such file), made on a throwaway index so neither main's index nor its files change. Returns
 *  its SHA. Throws when git refuses. */
function keptCommit(root, { files, tip, message }) {
  const dir = mkdtempSync(join(tmpdir(), "agentry-cut-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
  try {
    indexGit(root, env, ["read-tree", "HEAD"]);
    const at = new Map();
    const out = indexGit(root, env, [
      "--literal-pathspecs",
      "ls-tree",
      "-r",
      "-z",
      tip,
      "--",
      ...files,
    ]);
    for (const line of out.split("\0").filter(Boolean)) {
      const tab = line.indexOf("\t");
      const [mode, , sha] = line.slice(0, tab).split(" ");
      at.set(line.slice(tab + 1), `${mode} ${sha}`);
    }
    const zero = "0".repeat(commitOf(root, "HEAD").length);
    const info = files.map((f) => `${at.get(f) ?? `0 ${zero}`}\t${f}\0`).join("");
    indexGit(root, env, ["update-index", "-z", "--index-info"], info);
    const tree = indexGit(root, env, ["write-tree"]).trim();
    return indexGit(root, env, ["commit-tree", tree, "-p", "HEAD", "-m", message]).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The decision `given` names on the board, as the board writes it (its prefix and id), or null.
function boardDecision({ spec, model }, given) {
  const name = decisionKind(spec);
  if (!name)
    return { problem: "the board has no decision kind, so a cut cannot name its decision" };
  const prefix = spec.kinds[name].id?.prefix ?? "";
  const ids = (own(model?.kinds, name)?.items ?? []).map((i) => `${prefix}${i.id}`);
  const id = ids.find((d) => d.toLowerCase() === given.toLowerCase());
  return id ? { id } : { problem: `${given} is not a decision on the board` };
}

/** Every check of the cut, read only: `{ decision, tip, keptName, files, message, tier, board, main,
 *  warnings, dirty }`. Throws through `refuse` (nothing written). */
function planCut(ctx, ledger, refuse) {
  const { root, spec, model, kind, id } = ctx;
  if (ledger.state === "merged") refuse(`${id} is merged: nothing to cut`);
  if (ledger.state === "closed")
    refuse(`${id} is closed${ledger.cut ? " (cut)" : ""}: nothing to cut`);
  if (ledger.state === "merging")
    refuse(
      ledger.merge?.cut
        ? `a cut of ${id} stopped mid-land (step ${ledger.merge.step ?? "?"}): put main back at ${short(ledger.merge.preHead)} by hand if it holds the kept commit, then lane merge ${id} --resolve rolled-back`
        : `${id} is mid-land (merge step ${ledger.merge?.step ?? "?"}): finish the land first`,
    );
  const landing = ledgers.list(root).find((l) => l.id !== id && l.state === "merging");
  if (landing) refuse(`main is mid-land (${landing.id}): cut after it lands or is resolved`);
  const out = expects(ledger);
  if (out === "report") refuse("a builder is out: hold it first");
  if (out === "verdict") refuse("a verifier is out: record its verdict first");
  if (gatingNow(root, id)) refuse(`a gate for ${id} is queued or running: cut after it`);
  const decision = boardDecision(ctx, ctx.decision);
  if (decision.problem) refuse(decision.problem);

  if (spec.lifecycle) {
    const life = lifecycleOf(spec, kind);
    const key = kind === spec.lifecycle.kind ? "lifecycle.on.cut" : `exec.kinds.${kind}.on.cut`;
    if (typeof own(life?.on, "cut") !== "string")
      refuse(`the workflow file has no ${key}: add it, the ${kind} status a cut lane's item gets`);
  }
  const tips = branchTips(root);
  const branch = resolveBranch(root, ledger.branch, tips);
  if (branch.problem && !branch.missing) refuse(branch.problem);
  const tip = branch.tip ?? null;
  const keptName = branchOf(`${id}.cut`);
  if (tip && [...tips.keys()].some((b) => b.toLowerCase() === keptName.toLowerCase()))
    refuse(`${keptName} exists: rename or delete it first`);
  const left = leftover(root, ledger, spec.cleanup?.disposable ?? []);
  if (left.problem) refuse(left.problem.replace(/, then restart$/, ", then cut"));
  if (left.ignored.length)
    refuse(
      `the worktree ${ledger.worktree} holds ${left.ignored.length} ignored file(s) the cut would delete (${listed(left.ignored)}): copy what you need out and remove them, or add them to cleanup.disposable, then cut`,
    );
  let dirty = [];
  try {
    if (existsSync(ledger.worktree)) dirty = porcelain(ledger.worktree);
  } catch (e) {
    refuse(`the worktree ${ledger.worktree} cannot be read: ${e.message}`);
  }

  const plan = { decision: decision.id, tip, keptName, files: [], warnings: [], dirty };
  if (ctx.keep !== null) {
    if (!tip) refuse(`${id} has no branch ${ledger.branch}: nothing to keep from`);
    const base = mergeBaseOf(root, ledger.mainBranch, tip);
    const changed = base ? changedSince(root, base, tip) : null;
    if (!changed)
      refuse(`git cannot say what ${ledger.branch} changes against ${ledger.mainBranch}`);
    const kept = keptFiles(ctx.keep, changed);
    if (kept.problem) refuse(kept.problem);
    plan.files = kept.files;
    const same = git(root, [
      "--literal-pathspecs",
      "diff",
      "--quiet",
      "HEAD",
      tip,
      "--",
      ...kept.files,
    ]);
    if (same.status === 0)
      refuse(
        `the kept files are on ${ledger.mainBranch} already as ${short(tip)} has them: cut without --keep`,
      );
    plan.message = ctx.message ?? defaultMessage(id, plan.files);
    const credit = attributionIn(plan.message);
    if (credit)
      refuse(`the message carries AI attribution ("${credit}"): commits carry the author only`);
    const rules = rulesOf(spec);
    const [broken] = rules ? checkCommits(rules, [{ sha: "cut", message: plan.message }]) : [];
    if (broken)
      refuse(`the message breaks the repo's commit rules (${broken.why}): give --message`);
    const gate = gateOf(spec);
    if (!gate) refuse("the workflow file has no gate: a kept commit cannot be proved on main");
    plan.tier = pickTier(gate, "merge", {
      changed: plan.files,
      flagged: Boolean(ledger.route?.flagged),
    });
    const moved = changedSince(root, base, "HEAD") ?? [];
    const both = plan.files.filter((f) => moved.includes(f));
    if (both.length)
      plan.warnings.push(
        `! ${listed(both)}: changed on ${ledger.mainBranch} since the branch forked; the tip's content replaces it`,
      );
  }
  // Main takes a commit: the kept one, or the board commit of the cut word.
  if (ctx.keep !== null || spec.lifecycle) {
    const lane = { root, spec, model, id, kind, opts: {}, ledger };
    const main = mainRow(lane, { carry: true });
    if (main.mark === "red") refuse([main.detail, ...main.more].join("\n  "));
    plan.main = main.detail;
  }
  plan.boardMessage = `chore(board): cut ${id} (${decision.id})`;
  const event = applyEvent({ root, spec, model, event: "cut", id, kind, preview: true });
  plan.board = event;
  return plan;
}

// The board's answer as one line: what it writes, or why nothing.
const boardLine = ({ writes, skipped }) =>
  [...writes.map((w) => `${w.file}: ${w.what}`), ...skipped.map((s) => `${s.what}: ${s.why}`)].join(
    "; ",
  ) || "nothing to write";

// Each file of `files` whose text on main differs from HEAD's.
const changedOnMain = (root, files) =>
  files.filter((file) => {
    let now = null;
    try {
      now = readFileSync(join(root, file), "utf8");
    } catch {} // gone: differs from HEAD when HEAD has it
    return now !== textAt(root, "HEAD", file);
  });

/** The cut's land, through the land's steps: main's row and the set-aside of its uncommitted writes; with
 *  `--keep` the kept commit picked and gated (rolled back on red); with a lifecycle the board's record and
 *  commit: the carried and recorded writes back on main, the `cut` word, one board commit; then the owner's
 *  guard.allow edits back. `{ commit, boardCommit, board, rows, merge, ledger }`, `merge` the ledger's land
 *  record as it was before the cut. A stop before the board commit leaves main and the lane as they were
 *  and throws through `stop` (or `refuse` when nothing changed). */
function landCut(ctx, ledger, plan, { refuse, stop }) {
  const { root, spec, id, kind } = ctx;
  const keeps = plan.files.length > 0;
  const lane = { ...ctx, opts: {}, ledger, gate: gateOf(spec), files: [] };
  const rows = [];
  const text = (why) => [why, ...rowLines(rows)].join("\n");
  const main = ledger.mainBranch;
  if (carryBackStep(lane, rows)) stop(text("the carry an earlier land set aside did not go back"));
  if (mainStep(lane, rows)) refuse(text(`${main} cannot take the cut's commits`));
  const was = lane.ledger.merge;
  const stateBefore = lane.ledger.state;
  let made = null;
  if (keeps)
    try {
      made = keptCommit(root, { files: plan.files, tip: plan.tip, message: plan.message });
    } catch (e) {
      refuse(`the kept commit could not be made: ${e.message}`);
    }
  // What goes back at a stop: the set-aside files, then the lane's own state and land record.
  const back = () => {
    const given = giveBack(lane);
    if (given) rows.push(given);
    if (given?.mark === "red") return false;
    save(lane, { state: stateBefore, merge: was });
    return true;
  };
  if (takeCarryStep(lane, rows)) {
    back();
    stop(text(`${main}'s uncommitted writes could not be set aside`));
  }
  const preHead = commitOf(root, "HEAD");
  save(lane, {
    state: "merging",
    merge: {
      ...lane.ledger.merge,
      cut: true,
      preHead,
      planned: made ? [made] : [],
      landed: [],
      tip: plan.tip,
      stateBefore,
      step: made ? "picking" : "gated",
      at: now(),
    },
  });
  let commit = null;
  if (made) {
    const picked = cherryPick(root, { shas: [made], preHead });
    if (!picked.ok) {
      if (picked.restored) back();
      stop(
        text(
          `the kept commit did not land: ${picked.reason}${picked.restored ? `; ${main} is back at ${short(preHead)}` : `; ${main} is NOT back at ${short(preHead)}: look at it by hand`}`,
        ),
      );
    }
    const got = landedSince(root, lane.ledger.merge);
    if (got.error || got.rest.length)
      stop(text(`${main} does not hold the kept commit: ${got.error ?? "not picked"}`));
    [commit] = got.landed;
    setMerge(lane, { step: "landed", landed: got.landed });
    rows.push(ok("land", `${short(commit)} picked onto ${short(preHead)}: "${plan.message}"`));
    if (gateStep(lane, rows)) {
      if (!["rolled-back", "rollback-refused"].includes(lane.ledger.merge.step))
        rollBack(lane, rows);
      if (lane.ledger.merge.step !== "rolled-back")
        stop(
          text(
            `the gate stopped the cut, and ${main} still holds the kept commit ${short(commit)} on ${short(preHead)}: take it off by hand (git reset --keep ${short(preHead)}), then lane merge ${id} --resolve rolled-back`,
          ),
        );
      const whole = back();
      stop(
        text(
          `the gate on the kept commit stopped it: ${main} is back at ${short(preHead)}${whole ? `, and ${id} is as it was (${stateBefore})` : ""}`,
        ),
      );
    }
  }
  if (!spec.lifecycle) {
    const given = giveBack(lane);
    if (given) rows.push(given);
    if (given?.mark === "red")
      stop(text(`${short(commit)} is on ${main}, but the writes set aside for it did not go back`));
    return { commit, boardCommit: null, board: plan.board, rows, merge: was, ledger: lane.ledger };
  }
  // The record and commit: every board write main carried, the cut word on top, in one commit. A stop
  // here takes the board files back to HEAD, the kept commit off main, and the set-aside writes back.
  const carried = lane.ledger.merge.carry;
  const writes = lane.ledger.merge.writes;
  const touched = [...new Set([...(carried?.files ?? []), ...(writes?.files ?? [])])];
  const undo = (why) => {
    const restored = restoreFiles(root, touched);
    if (restored.ok && made) rollBack(lane, rows);
    const whole = restored.ok && lane.ledger.merge.step !== "rollback-refused" && back();
    stop(
      text(
        `${why}${whole ? `: ${main} is back at ${short(preHead)}, and ${id} is as it was (${stateBefore})` : `; ${main} and the ledger's merge record need a look by hand`}`,
      ),
    );
  };
  if (carryWritesStep(lane, rows))
    undo("the recorded board writes did not go back for the board commit");
  if (carried) {
    const put = putCells(root, spec, carried.cells);
    if (!put.ok) undo(`exec's board writes do not apply on ${main} (${carried.files.join(", ")})`);
  }
  let board;
  try {
    const model = readProcess({ root, spec });
    board = applyEvent({ root, spec, model, event: "cut", id, kind });
  } catch (e) {
    if (!(e instanceof WriteError)) throw e;
    undo(`the board write refused: ${e.message}`);
  }
  touched.push(...board.writes.map((w) => w.file).filter((f) => !touched.includes(f)));
  const files = changedOnMain(root, touched);
  let boardSha = null;
  if (files.length) {
    const res = boardCommit(root, { files, message: plan.boardMessage });
    if (!res.ok) undo(`the board commit refused: ${first(res.reason)}`);
    boardSha = res.sha;
    setMerge(lane, { carry: undefined });
    releaseWrites(lane);
    rows.push(
      ok("commit", `${short(boardSha)} ${plan.boardMessage}`, [`files: ${files.join(", ")}`]),
    );
    if (res.left.length)
      rows.push(warn("commit", `${main} is not clean after it`, res.left.slice(0, SHOWN)));
  }
  const allow = putBackAllow(lane);
  if (allow) rows.push(allow);
  if (allow?.mark === "red")
    stop(text(`the cut is on ${main}, but the guard.allow edits set aside for it did not go back`));
  return { commit, boardCommit: boardSha, board, rows, merge: was, ledger: lane.ledger };
}

// Keep the branch as `keptName`: a ref made at the listed tip (refused when one is there), then the old
// one deleted at that tip, never `branch -D` or a read by name. null, or why it did not.
function keepBranch(root, { branch, tip, keptName }) {
  const zero = "0".repeat(tip.length);
  const made = git(root, ["update-ref", `refs/heads/${keptName}`, tip, zero]);
  if (made.status !== 0) return `git update-ref refs/heads/${keptName}: ${first(made.stderr)}`;
  const gone = git(root, ["update-ref", "-d", `refs/heads/${branch}`, tip]);
  return gone.status === 0 ? null : `git update-ref -d refs/heads/${branch}: ${first(gone.stderr)}`;
}

/** `lane exec cut <id> --decision <D> [--keep <paths>] [--message <subject>] [--apply]`. */
export function cutLane(ctx, id, { ledger, refuse, stop, laneLine }) {
  const { root, spec, apply } = ctx;
  const plan = planCut({ ...ctx, id }, ledger, refuse);
  const keeps = plan.files.length > 0;
  const shown = {
    decision: plan.decision,
    kept: keeps ? plan.files : "none: nothing lands on main",
    ...(keeps && {
      land: `one commit on ${ledger.mainBranch}, ${plan.files.length} file(s) as ${short(plan.tip)} has them: "${plan.message}"`,
      gate: `${plan.tier.tier ?? "none"} (${plan.tier.reason})`,
    }),
    ...(plan.main && { main: plan.main }),
    board: `${boardLine(plan.board)}${plan.board.writes.length ? `; committed on ${ledger.mainBranch} as "${plan.boardMessage}", with the board writes main carries` : ""}`,
    worktree: `${ledger.worktree} removed${plan.dirty.length ? `, its ${plan.dirty.length} uncommitted file(s) saved first` : ""}`,
    branch: plan.tip ? `${ledger.branch} kept as ${plan.keptName}` : "none",
    ...(plan.warnings.length && { warning: plan.warnings.join("\n") }),
  };
  const result = (fields) => ({
    exit: 0,
    out: JSON.stringify({ id, step: "cut", ...fields }, null, 2),
  });
  if (!apply) {
    const flags = [
      `--decision ${shellWord(plan.decision)}`,
      ...(keeps ? [`--keep ${shellWord(ctx.keep)}`] : []),
      ...(ctx.message !== null ? [`--message ${shellWord(ctx.message)}`] : []),
      "--apply",
    ];
    return result({
      next: laneLine(root, "cut", id, ` ${flags.join(" ")}`),
      state: ledger.state,
      ...shown,
      preview: PREVIEW,
    });
  }

  const diff = join(ledgers.runDir(root, id), "cut", "uncommitted.diff");
  if (plan.dirty.length) {
    const saved = saveWork(ledger.worktree, diff);
    if (saved.error) refuse(`the worktree's uncommitted work could not be saved: ${saved.error}`);
  }
  let landed = {
    commit: null,
    boardCommit: null,
    board: plan.board,
    rows: [],
    merge: ledger.merge,
    ledger,
  };
  if (keeps || spec.lifecycle) {
    try {
      landed = landCut({ ...ctx, id }, ledger, plan, { refuse, stop });
    } catch (e) {
      if (plan.dirty.length) rmSync(diff, { force: true });
      throw e;
    }
  }
  const { merge: _land, ...rest } = landed.ledger;
  const closed = ledgers.write(root, {
    ...rest,
    ...(landed.merge !== undefined && { merge: landed.merge }),
    state: "closed",
    next: null,
    cut: {
      decision: plan.decision,
      kept: plan.files,
      commit: landed.commit,
      boardCommit: landed.boardCommit,
      at: now(),
      ...(plan.dirty.length && { uncommitted: diff }),
    },
  });
  // Past the ledger the cut stands: what fails now is finished by hand, as the stop says.
  const done = `${id} is cut (its ledger is closed)${landed.commit ? `, ${short(landed.commit)} on ${ledger.mainBranch}` : ""}`;
  const gone = remove(root, { path: ledger.worktree, branch: null, force: true });
  if (!gone.removed)
    stop(
      `${done}, but its worktree was not removed: ${gone.reason} → git worktree remove -f -f ${shellWord(ledger.worktree)}`,
    );
  const why = plan.tip
    ? keepBranch(root, { branch: ledger.branch, tip: plan.tip, keptName: plan.keptName })
    : null;
  if (why)
    stop(
      `${done}, but its branch was not kept as ${plan.keptName}: ${why} → git update-ref refs/heads/${plan.keptName} ${plan.tip}; git update-ref -d refs/heads/${ledger.branch} ${plan.tip}`,
    );
  const { gate: _gate, main: _main, ...told } = shown;
  return result({
    next: null,
    state: closed.state,
    ...told,
    board: boardLine(landed.board),
    ...(landed.commit && { commit: landed.commit }),
    ...(landed.boardCommit && { boardCommit: landed.boardCommit }),
    ...(landed.rows.length && { land: rowLines(landed.rows).join("\n") }),
    ...(plan.dirty.length && { uncommitted: diff }),
  });
}
