// exec/cut/land — the cut's land, with `--apply` and `--keep`: the kept paths' content at the lane's tip
// becomes one commit made off main (a throwaway index on main's HEAD, so main's checkout is never touched
// to build it), landed by the land's own steps: main's row and the carry of exec's writes
// (`merge/main-row.mjs`, `merge/carry.mjs`), the cherry-pick and what main holds after it (`land.mjs`),
// the merge role's gate tier on those paths and the rollback on red (`merge/gating.mjs`). Once the
// commit is gated its land record leaves the ledger, so the other lanes' guards judge it as any commit on
// main (decision 51: only an overlap with their files trips) and drift never reads it as a land. Then, as
// the land's record and commit steps do, exec's carried writes and the owner's recorded board writes go
// back on the board with the lifecycle's `cut` word, and one board commit holds them (`land.mjs`'s
// `boardCommit`, `chore(board): cut <id> (<D>)`), so main is clean for the next land; the owner's
// guard.allow edits go back after it.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentOf as contentIds } from "../../../process/board-writes.mjs";
import { applyEvent } from "../../../process/lifecycle.mjs";
import { readProcess } from "../../../process/read.mjs";
import { gateOf } from "../../../process/spec/workflow.mjs";
import { WriteError } from "../../../process/write.mjs";
import { putCells } from "../../carry-io.mjs";
import { short } from "../../fmt.mjs";
import {
  boardCommit,
  cherryPick,
  commitOf,
  landedSince,
  restoreFiles,
  textAt,
} from "../../land.mjs";
import { carryWritesStep, putBackAllow } from "../../merge/aside.mjs";
import { carryBackStep, giveBack, takeCarryStep } from "../../merge/carry.mjs";
import { gateStep, rollBack } from "../../merge/gating.mjs";
import { now, ok, save, setMerge, warn } from "../../merge/lane.mjs";
import { mainStep } from "../../merge/main-row.mjs";
import { refuse, stop } from "../lane.mjs";
import { SHOWN, STUCK_STEP } from "./plan.mjs";

export const first = (text) => String(text).trim().split("\n")[0] ?? "";
const MARK = { ok: "✓", warn: "!", red: "✗", skip: "·", wait: "…" };

// The land's step rows as lines, as `lane merge` prints them.
export const rowLines = (rows) =>
  rows.flatMap((r) => [`${MARK[r.mark]} ${r.step} ${r.detail}`, ...r.more.map((m) => `  ${m}`)]);

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
export function landCut(ctx, ledger, plan) {
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
          `the kept commit did not land: ${picked.reason}${picked.restored ? `; ${main} is back at ${short(preHead)}` : `; ${main} is NOT back at ${short(preHead)}: clear what git left, then ${STUCK_STEP(id)}`}`,
        ),
      );
    }
    const got = landedSince(root, lane.ledger.merge);
    if (got.error || got.rest.length)
      stop(
        text(
          `${main} does not hold the kept commit: ${got.error ?? "not picked"} → ${STUCK_STEP(id)}`,
        ),
      );
    [commit] = got.landed;
    setMerge(lane, { step: "landed", landed: got.landed });
    rows.push(ok("land", `${short(commit)} picked onto ${short(preHead)}: "${plan.message}"`));
    if (gateStep(lane, rows)) {
      if (!["rolled-back", "rollback-refused"].includes(lane.ledger.merge.step))
        rollBack(lane, rows);
      if (lane.ledger.merge.step !== "rolled-back")
        stop(
          text(
            `the gate stopped the cut, and ${main} still holds the kept commit ${short(commit)} on ${short(preHead)}: clear what the rollback row names, then ${STUCK_STEP(id)} rolls it back`,
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
      stop(
        text(
          `${short(commit)} is on ${main}, but the writes set aside for it did not go back → ${STUCK_STEP(id)}`,
        ),
      );
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
        `${why}${whole ? `: ${main} is back at ${short(preHead)}, and ${id} is as it was (${stateBefore})` : `; the cut is stuck: clear what the rows name, then ${STUCK_STEP(id)} rolls it back`}`,
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
    // The commit's identity before it is made: its parent and each file's blob, so a rerun after a kill
    // knows it as the cut's own and nothing else (`recoverCut`).
    setMerge(lane, {
      boardPlan: { parent: commitOf(root, "HEAD"), files: contentIds(root, files) },
    });
    const res = boardCommit(root, { files, message: plan.boardMessage });
    if (!res.ok) undo(`the board commit refused: ${first(res.reason)}`);
    boardSha = res.sha;
    setMerge(lane, { carry: undefined, writes: undefined, cutBoard: boardSha });
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
