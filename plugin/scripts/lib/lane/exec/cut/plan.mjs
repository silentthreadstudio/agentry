import { existsSync } from "node:fs";
// exec/cut/plan — every check of `lane exec cut <id>` (field 95), read only: the lane at rest and main not
// mid-land, the board's decision, the lifecycle's `cut` word, the branch and the name it is kept as, the
// worktree's leftovers, and with `--keep` the kept paths, their message, the gate tier and main's row.
// Nothing is written, so a preview is the same answer. Also the words the cut's other steps share: the
// step that rolls a stuck cut back and a capped list.
import { posix } from "node:path";
import { branchTips } from "../../../process/git.mjs";
import * as ledgers from "../../../process/ledger.mjs";
import { applyEvent } from "../../../process/lifecycle.mjs";
import { escapesRoot, own } from "../../../process/spec/shape.mjs";
import { gateOf, lifecycleOf } from "../../../process/spec/workflow.mjs";
import { resolveBranch } from "../../adopt.mjs";
import { decisionKind } from "../../decisions.mjs";
import { short } from "../../fmt.mjs";
import { changedSince, pickTier } from "../../gate.mjs";
import { attributionIn, mergeBaseOf } from "../../land.mjs";
import { mainRow } from "../../merge/main-row.mjs";
import { gatingNow } from "../../restack.mjs";
import { leftover } from "../../restart.mjs";
import { expects } from "../../rounds.mjs";
import { checkCommits, rulesOf } from "../../subjects.mjs";
import { branchOf, git, porcelain } from "../../worktree.mjs";
import { refuse } from "../lane.mjs";

export const SHOWN = 5;
export const listed = (items) =>
  items.slice(0, SHOWN).join(", ") +
  (items.length > SHOWN ? ` (+${items.length - SHOWN} more)` : "");

// The step that rolls back a cut a kill left mid-land: the cut itself, run again with --apply.
export const STUCK_STEP = (id) => `exec cut ${id} --decision <D> --apply`;

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
export function planCut(ctx, ledger) {
  const { root, spec, model, kind, id } = ctx;
  if (ledger.state === "merged") refuse(`${id} is merged: nothing to cut`);
  if (ledger.state === "closed")
    refuse(`${id} is closed${ledger.cut ? " (cut)" : ""}: nothing to cut`);
  if (ledger.state === "merging")
    refuse(
      ledger.merge?.cut
        ? `a cut of ${id} stopped mid-land (step ${ledger.merge.step ?? "?"}): ${STUCK_STEP(id)} rolls it back (main to ${short(ledger.merge.preHead)}, the set-aside writes back, ${id} ${ledger.merge.stateBefore ?? "as it was"} again), then cut again`
        : `${id} is mid-land (merge step ${ledger.merge?.step ?? "?"}): finish the land first`,
    );
  const landing = ledgers.list(root).find((l) => l.id !== id && l.state === "merging");
  if (landing)
    refuse(
      `main is mid-land (${landing.id}): ${landing.merge?.cut ? `${STUCK_STEP(landing.id)} rolls back its stuck cut` : "cut after it lands"}`,
    );
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
