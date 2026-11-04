// merge/rows — the rows the preflight and the land both read before main changes: the ledger (adopting
// a `--branch`), the board, the commits to land, the repo checks and the push policy.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "../../config.mjs";
import { branchTips, defaultBranch, worktrees } from "../../process/git.mjs";
import {
  list as listLedgers,
  read as readLedger,
  write as writeLedger,
} from "../../process/ledger.mjs";
import { own } from "../../process/spec/shape.mjs";
import { flaggedItem, gateOf, lifecycleOf } from "../../process/spec/workflow.mjs";
import { resolveBranch, shownName, strayTree, unnamedHead } from "../adopt.mjs";
import { headBoard } from "../carry-io.mjs";
import { changedSince, checklistFor } from "../gate.mjs";
import { commitOf, commitsBetween, isAncestor, mergeBaseOf, subjectOf, toLand } from "../land.mjs";
import { dirtyEntries } from "../own-memory.mjs";
import { verdicts } from "../rounds.mjs";
import { chainOf } from "../stack.mjs";
import { brokenIn, rulesOf, withTypeHints } from "../subjects.mjs";
import { findByBranch } from "../worktree.mjs";
import { ok, red, save, short, skip, tipOf, wait, warn } from "./lane.mjs";

// The ledger states a land may start or resume from; an exec lane still building or verifying is not
// done, and a stopped one needs the owner.
const LANDABLE = ["verified", "merging", "merged"];

/** `--branch` as a branch to adopt, worded as `exec adopt` words it: `{ branch, tip }`, the tip from the
 *  branch list (`resolveBranch`), or `{ problem }`: no branch by that exact name (a worktree on it with no
 *  commits yet says so), a case twin, or the branch's worktree on a spelling no branch is named. */
function adoptable(root, branch) {
  const tips = branchTips(root);
  const all = worktrees(root);
  const named = resolveBranch(root, branch, tips);
  const checkedOut = all.some((t) => t.branch === branch);
  const folded = String(branch).toLowerCase();
  const inNoCase = ![...tips.keys()].some((b) => b.toLowerCase() === folded);
  if (named.missing && checkedOut && inNoCase)
    return { problem: `${shownName(branch)} has no commits yet` };
  if (named.problem) return named;
  const stray = checkedOut ? null : strayTree(all, branch, tips);
  return stray ? { problem: unnamedHead(stray) } : named;
}

/** The task's ledger, or one adopted from `--branch`. Returns a row, or { exit, rows, next? } to stop. */
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
        rows: [red("ledger", `${id}'s ledger is on ${ledger.branch}, not ${shownName(branch)}`)],
      };
    // A stopped exec lane lands only when the owner names its branch: it is adopted from then on.
    if (ledger.state === "stopped" && branch !== undefined && adopt) {
      const named = adoptable(root, branch);
      if (named.problem) return { exit: 2, rows: [red("ledger", named.problem)] };
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
    // exec.verify can route an item past its verifier; a flagged one never lands that way, whenever the
    // flag was set (the lane reads it again at its report, this reads it again at the land).
    if (
      ledger.origin === "exec" &&
      ledger.state !== "merged" &&
      verdicts(ledger).length === 0 &&
      flaggedItem(spec, lane.model, id, lane.kind)
    )
      return {
        exit: 2,
        rows: [
          red(
            "ledger",
            `${id} is flagged on the board, but no verifier read it (exec.verify skipped it): a flagged item lands only after a verdict`,
          ),
        ],
        next: `lane exec reverify ${id}`,
      };
    // What the lane closed on is what lands: a branch moved since (a rebase, a commit) is checked again first.
    const tip = commitOf(root, `refs/heads/${ledger.branch}`);
    if (
      ledger.origin === "exec" &&
      ledger.state !== "merged" &&
      ledger.closedTip &&
      tip !== ledger.closedTip
    )
      return {
        exit: 2,
        rows: [
          red(
            "ledger",
            `${ledger.branch} moved since the lane closed on ${short(ledger.closedTip)}: lane exec rebase ${id}`,
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
  // An exact listed name only: a revision, `refs/…`, another case or a case twin would land, and later
  // clean up, a branch other than the one named.
  const named = adoptable(root, branch);
  if (named.problem) return { exit: 2, rows: [red("ledger", named.problem)] };
  if (branch === mainBranch)
    return { exit: 2, rows: [red("ledger", `${branch} is the main branch itself`)] };
  const head = commitOf(root, "HEAD");
  const base = mergeBaseOf(root, mainBranch, named.tip);
  lane.ledger = writeLedger(root, {
    v: 1,
    id,
    kind: spec.lifecycle ? lane.kind : null,
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
/** The newest gate of `tier` the ledger holds from the worktree, whatever its exit (`canSkip` refuses a
 *  red one, so a red run after a green one is never passed over; a flaky red's green re-run is newer);
 *  with no `tier`, the newest worktree gate of any tier. Null when there is none. */
export const lastWorktreeGate = (ledger, tier) =>
  (ledger.gates ?? []).findLast(
    (g) => g.where === "worktree" && (tier === undefined || g.tier === tier),
  ) ?? null;

/** The item on the board, of the lane's kind. After a land killed while it wrote the board, the working
 *  copy holds that land's writes ("done" already), so the board is read as committed. */
export function boardRow({ root, spec, model, id, kind, ledger }) {
  if (!spec.lifecycle) return skip("board", "lifecycle off: the merge writes nothing to the board");
  const life = lifecycleOf(spec, kind);
  if (!life)
    return red("board", `"${kind}" is not a kind exec runs (lifecycle.kind or exec.kinds)`);
  const killed = ledger?.merge?.step === "recording";
  const board = killed ? headBoard(root, spec, model).model : model;
  const items = (own(board.kinds, life.kind)?.items ?? []).filter((item) => item.id === id);
  if (items.length !== 1)
    return red("board", `${items.length ? "several" : "no"} ${life.kind} "${id}" on the board`);
  const to = own(life.on, "merged") ?? "-";
  const is = `${life.kind} ${id} is "${items[0].status ?? ""}"${killed ? " as committed" : ""}`;
  return ok("board", `${is}; landing makes it "${to}"`);
}

// A lane in one of these has no branch left to land first.
const ENDED = ["merged", "closed", "stopped"];

// A ledger's ref goes to git only when it cannot be read as an option.
const safeRef = (ref) => typeof ref === "string" && ref !== "" && !ref.startsWith("-");

/** For each of `merges` (on `ledger`'s branch), the other lane whose branch it brings in: one still to
 *  land (not merged, closed or stopped, nor stacked on this lane) with a commit of its own past its main
 *  branch among the commits the merge adds past its first parent. `{ sha, id }`, `id` null for none. A
 *  lane whose branch or main branch could be read as a git option is never asked about. */
function lanesBroughtIn(root, ledger, merges) {
  const all = listLedgers(root);
  const others = all.filter(
    (l) =>
      l.id !== ledger.id &&
      safeRef(l.branch) &&
      safeRef(l.mainBranch ?? ledger.mainBranch) &&
      !ENDED.includes(l.state) &&
      !chainOf(all, l.on).includes(ledger.id),
  );
  const ranges = new Map();
  const rangeOf = (l) => {
    if (!ranges.has(l.id))
      ranges.set(
        l.id,
        commitsBetween(root, l.mainBranch ?? ledger.mainBranch, `refs/heads/${l.branch}`) ?? [],
      );
    return ranges.get(l.id);
  };
  return merges.map((sha) => {
    const brought = new Set(commitsBetween(root, `${sha}^1`, sha) ?? []);
    brought.delete(sha);
    const by = others.find((l) => rangeOf(l).some((c) => brought.has(c)));
    return { sha, id: by?.id ?? null };
  });
}

/** The commits to land, as a row: red when there is nothing to pick or a merge commit is in the way. A
 *  merge commit that brings in another lane's branch names that lane, to land first; `next` is then
 *  its land. */
export function commitsRow({ root, ledger }) {
  const { mainBranch, branch } = ledger;
  const plan = toLand(root, { main: mainBranch, branch });
  if (plan.error) return { row: red("commits", plan.error) };
  if (plan.merges.length > 0) {
    const head = `${branch} has ${plan.merges.length} merge commit(s), which a cherry-pick cannot land`;
    const rebase = `ask the builder to rebase onto ${mainBranch}`;
    const named = lanesBroughtIn(root, ledger, plan.merges);
    const first = named.find((m) => m.id)?.id;
    if (!first) return { row: red("commits", `${head}: ${rebase}`, plan.merges.map(short)) };
    const line = ({ sha, id }) =>
      id
        ? `merge ${short(sha)} brings in ${id}'s branch: land ${id} first (lane merge ${id}), then lane exec rebase ${ledger.id}`
        : `${short(sha)}: ${rebase}`;
    return { row: red("commits", head, named.map(line)), next: `lane merge ${first}` };
  }
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
  const behind = !isAncestor(root, mainBranch, branch);
  if (behind) more.push(`${branch} is not cut from ${mainBranch}'s tip: the picks may conflict`);
  // Not cut from main's tip lands as a rule, but may conflict: a warning, not a green tick.
  return { plan, row: (behind ? warn : ok)("commits", `${plan.picks.length} to land`, more) };
}

/** The commits row for the workflow file's `commits` rules, over the commits the land would pick: skipped
 *  with no rules, red naming the first commit that breaks one (the others under it), else a tick. Null when
 *  the picks can't be planned (`commitsRow` says why). */
export function subjectsRow({ root, spec, ledger }) {
  if (!rulesOf(spec)) return skip("commits", "no rules (commits in the workflow file)");
  const plan = toLand(root, { main: ledger.mainBranch, branch: ledger.branch });
  if (plan.error) return null;
  const broken = brokenIn(root, spec, plan.picks);
  if (broken.length === 0) return ok("commits", `${plan.picks.length} checked against commits`);
  // A subject that fails the pattern on a type main already uses says how to widen the pattern.
  const hinted = withTypeHints(root, ledger.mainBranch, rulesOf(spec), broken);
  const line = (c) => `${short(c.sha)} "${c.subject}": ${c.why}${c.hint ? `; ${c.hint}` : ""}`;
  return red("commits", line(hinted[0]), hinted.slice(1).map(line));
}

/** The checklist items this land waits on (`gate.checklist`): on the files the branch changes past its
 *  merge base with main (what the picks bring) and the lane's flag. */
function checklistItems({ root, spec, ledger }) {
  const gate = gateOf(spec);
  if (!gate?.checklist.length) return [];
  const base = ledger.branch && mergeBaseOf(root, ledger.mainBranch, ledger.branch);
  const changed = base ? changedSince(root, base, ledger.branch) : null;
  // A diff git cannot give (no merge base) fails safe, as the land's tier does: every item applies.
  if (!changed) return gate.checklist.map(({ name, text }) => ({ name, text }));
  return checklistFor(gate, { changed, flagged: Boolean(ledger.route?.flagged) });
}

/** The repo checks: each named skill must exist (exit 2), and it and each checklist item this land waits
 *  on must have an outcome recorded on the branch's current tip; `pending` lists the ones to record,
 *  `failed` the ones recorded as fail. */
export function checksState(lane) {
  const { root, spec, ledger } = lane;
  const names = spec.extensions?.merge?.checks ?? [];
  const items = checklistItems(lane);
  if (names.length === 0 && items.length === 0)
    return {
      row: skip(
        "checks",
        `none named (extensions.merge.checks)${spec.gate?.checklist ? "; no gate.checklist item applies" : ""}`,
      ),
      pending: [],
      failed: [],
    };
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
  const all = [...names.map((name) => ({ name })), ...items];
  for (const { name, text } of all) {
    const check = own(ledger.checks ?? {}, name);
    if (!check) {
      pending.push(name);
      more.push(`${name}: not recorded${text ? `: "${text}"` : ""}`);
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
  const passed = all.length - pending.length - failed.length;
  return { row: mark("checks", `${passed}/${all.length} passed`, more), pending, failed };
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
