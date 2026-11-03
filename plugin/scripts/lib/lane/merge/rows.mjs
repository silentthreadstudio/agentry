// merge/rows — the rows the preflight and the land both read before main changes: the ledger (adopting
// a `--branch`), the board, the commits to land, the repo checks and the push policy.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "../../config.mjs";
import { defaultBranch, worktrees } from "../../process/git.mjs";
import { read as readLedger, write as writeLedger } from "../../process/ledger.mjs";
import { own } from "../../process/spec.mjs";
import { headBoard } from "../carry-io.mjs";
import { commitOf, isAncestor, mergeBaseOf, subjectOf, toLand } from "../land.mjs";
import { dirtyEntries } from "../own-memory.mjs";
import { findByBranch } from "../worktree.mjs";
import { ok, red, save, short, skip, tipOf, wait } from "./lane.mjs";

// The ledger states a land may start or resume from; an exec lane still building or verifying is not
// done, and a stopped one needs the owner.
const LANDABLE = ["verified", "merging", "merged"];

/** The task's ledger, or one adopted from `--branch`. Returns a row, or { exit, rows } to stop. */
export function ledgerStep(lane, { adopt }) {
  const { root, id, opts, spec } = lane;
  const branch = opts["--branch"];
  let ledger;
  try {
    ledger = readLedger(root, id);
  } catch (error) {
    return { exit: 2, rows: [red("ledger", error.message)] };
  }
  if (ledger) {
    lane.ledger = ledger;
    if (branch !== undefined && branch !== ledger.branch)
      return {
        exit: 2,
        rows: [red("ledger", `${id}'s ledger is on ${ledger.branch}, not ${branch}`)],
      };
    // A stopped exec lane lands only when the owner names its branch: it is adopted from then on.
    if (ledger.state === "stopped" && branch !== undefined && adopt) {
      save(lane, { origin: "adopted", adoptedFrom: "stopped", state: "merging" });
      return ok("ledger", `adopted the stopped exec lane on ${branch} (origin now "adopted")`);
    }
    if (!LANDABLE.includes(ledger.state))
      return {
        exit: 2,
        rows: [
          red(
            "ledger",
            ledger.state === "stopped"
              ? `${id}'s lane is "stopped": land it anyway only on the owner's call, with --branch ${ledger.branch}`
              : `${id}'s lane is "${ledger.state}": only a verified lane lands (lane exec show ${id})`,
          ),
        ],
      };
    return ok("ledger", `${ledger.origin} ledger, state ${ledger.state}`);
  }
  if (branch === undefined || !adopt)
    return {
      exit: 2,
      rows: [
        red(
          "ledger",
          `no ledger for ${id}: build it with /agentry:exec ${id}, or adopt a branch with --branch <b>`,
        ),
      ],
    };
  const mainBranch = defaultBranch(root);
  if (!mainBranch)
    return { exit: 2, rows: [red("ledger", "no main branch (origin/HEAD, main or master) here")] };
  if (branch.startsWith("-") || !commitOf(root, `refs/heads/${branch}`))
    return { exit: 2, rows: [red("ledger", `"${branch}" is not a local branch`)] };
  if (branch === mainBranch)
    return { exit: 2, rows: [red("ledger", `${branch} is the main branch itself`)] };
  const head = commitOf(root, "HEAD");
  const base = mergeBaseOf(root, mainBranch, branch);
  lane.ledger = writeLedger(root, {
    v: 1,
    id,
    kind: spec.lifecycle?.kind ?? null,
    contract: null,
    origin: "adopted",
    mainBranch,
    base,
    worktree: findByBranch(root, branch),
    branch,
    mainAtStart: { head, porcelain: dirtyEntries(root) ?? [] },
    worktreesAtStart: worktrees(root).map((tree) => tree.path),
    rounds: [],
    gates: [],
    checks: {},
    usedMemories: [],
    state: "merging",
    next: "",
  });
  return ok("ledger", `adopted ${branch}: ledger created (origin "adopted")`);
}

// Repo skills live in the host's own folder (A28); `extensions.merge.checks` names them natively.
export const SKILL_DIR = ".claude/skills";
export const skillExists = (root, name) => existsSync(join(root, SKILL_DIR, name, "SKILL.md"));
/** The last gate the ledger holds from the worktree, or null. */
export const lastWorktreeGate = (ledger) =>
  (ledger.gates ?? []).findLast((g) => g.where === "worktree") ?? null;

/** The task on the board. After a land killed while it wrote the board, the working copy holds that
 *  land's writes ("done" already), so the board is read as committed. */
export function boardRow({ root, spec, model, id, ledger }) {
  const life = spec.lifecycle;
  if (!life) return skip("board", "lifecycle off: the merge writes nothing to the board");
  const killed = ledger?.merge?.step === "recording";
  const board = killed ? headBoard(root, spec, model).model : model;
  const items = (own(board.kinds, life.kind)?.items ?? []).filter((item) => item.id === id);
  if (items.length !== 1)
    return red("board", `${items.length ? "several" : "no"} ${life.kind} "${id}" on the board`);
  const to = own(life.on, "merged") ?? "-";
  const is = `${life.kind} ${id} is "${items[0].status ?? ""}"${killed ? " as committed" : ""}`;
  return ok("board", `${is}; landing makes it "${to}"`);
}

/** The commits to land, as a row: red when there is nothing to pick or a merge commit is in the way. */
export function commitsRow({ root, ledger }) {
  const { mainBranch, branch } = ledger;
  const plan = toLand(root, { main: mainBranch, branch });
  if (plan.error) return { row: red("commits", plan.error) };
  if (plan.merges.length > 0)
    return {
      row: red(
        "commits",
        `${branch} has ${plan.merges.length} merge commit(s), which a cherry-pick cannot land: ask the builder to rebase onto ${mainBranch}`,
        plan.merges.map(short),
      ),
    };
  if (plan.picks.length === 0)
    return {
      row: red(
        "commits",
        plan.onMain.length > 0
          ? `every commit of ${branch} is already on ${mainBranch} (same patch): nothing to land; if it was merged by hand, board fix records it`
          : `${branch} has no commits past ${mainBranch}: nothing to land`,
      ),
    };
  const more = plan.picks.map((sha) => `${short(sha)} ${subjectOf(root, sha)}`);
  if (plan.onMain.length > 0)
    more.push(`${plan.onMain.length} commit(s) already on ${mainBranch} (same patch), not picked`);
  if (!isAncestor(root, mainBranch, branch))
    more.push(`${branch} is not cut from ${mainBranch}'s tip: the picks may conflict`);
  return { plan, row: ok("commits", `${plan.picks.length} to land`, more) };
}

/** The repo checks: each named skill must exist (exit 2) and have an outcome recorded on the branch's
 *  current tip; `pending` lists the ones to record, `failed` the ones recorded as fail. */
export function checksState(lane) {
  const { root, spec, ledger } = lane;
  const names = spec.extensions?.merge?.checks ?? [];
  if (names.length === 0)
    return { row: skip("checks", "none named (extensions.merge.checks)"), pending: [], failed: [] };
  const missing = names.filter((name) => !skillExists(root, name));
  if (missing.length > 0)
    return {
      exit: 2,
      row: red(
        "checks",
        "extensions.merge.checks names skill(s) this repo does not have",
        missing.map((name) => `${name}: no ${SKILL_DIR}/${name}/SKILL.md`),
      ),
    };
  const tip = tipOf(lane);
  const pending = [];
  const failed = [];
  const more = [];
  for (const name of names) {
    const check = own(ledger.checks ?? {}, name);
    if (!check) {
      pending.push(name);
      more.push(`${name}: not recorded`);
    } else if (check.tip && check.tip !== tip) {
      pending.push(name);
      more.push(
        `${name}: ${check.result} on ${short(check.tip)}, but the branch is at ${short(tip)}: record it again`,
      );
    } else {
      if (check.result === "fail") failed.push(name);
      more.push(`${name}: ${check.result}${check.note ? ` (${check.note})` : ""}`);
    }
  }
  const mark = failed.length > 0 ? red : pending.length > 0 ? wait : ok;
  const passed = names.length - pending.length - failed.length;
  return { row: mark("checks", `${passed}/${names.length} passed`, more), pending, failed };
}

export function pushRow({ root }) {
  const config = readConfig(root);
  if (config.error) return red("push", config.error);
  const policy = config.merge.push;
  const says = {
    auto: "the merge pushes after the board commit",
    ask: "the owner is asked before the push",
    never: "the owner pushes; merge never does",
  };
  return ok("push", `merge.push is "${policy}": ${says[policy]}`);
}
