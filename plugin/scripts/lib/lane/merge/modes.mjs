// merge/modes — the three small `lane merge` modes around the land (plan R1b-5): `--check` records a
// repo check on the branch's tip, `--push` pushes main per `merge.push`, `--cleanup` takes the worktree
// and branch down, found by branch.
import { join } from "node:path";
import { refuse, usageError } from "../../cli/help.mjs";
import { readConfig } from "../../config.mjs";
import { read as readLedger } from "../../process/ledger.mjs";
import { cleanup, commitOf, isAncestor, push } from "../land.mjs";
import { worktreesDir } from "../worktree.mjs";
import { mainRow } from "./carry.mjs";
import { afterLand, checkNext, done, landNext, now, ok, red, save, short, tipOf } from "./lane.mjs";
import { SKILL_DIR, checksState, skillExists } from "./rows.mjs";

const CHECK_RESULTS = ["pass", "fail"];

// The ledger for a step after the land, or the refusal when it is missing or not landed yet.
function mergedLedger(lane, step) {
  let ledger;
  try {
    ledger = readLedger(lane.root, lane.id);
  } catch (error) {
    return done(2, lane, [red(step, error.message)]);
  }
  if (!ledger) return done(2, lane, [red(step, `no ledger for ${lane.id}`)]);
  lane.ledger = ledger;
  if (ledger.state !== "merged")
    return done(2, lane, [red(step, `${lane.id} is not landed yet`)], landNext(lane.id));
  return null;
}

export function check(lane) {
  const { root, spec, id, opts } = lane;
  const no = (why, next) => refuse(`lane merge ${id} --check`, why, next);
  const value = opts["--check"];
  const at = value.lastIndexOf("=");
  const [skill, result] = at > 0 ? [value.slice(0, at), value.slice(at + 1)] : [value, ""];
  if (!CHECK_RESULTS.includes(result))
    return usageError("lane merge", `--check takes <skill>=pass|fail, not "${value}"`);
  const names = spec.extensions?.merge?.checks ?? [];
  if (!names.includes(skill)) {
    const named = names.length ? names.join(", ") : "none named";
    return no(`"${skill}" is not in extensions.merge.checks (${named})`);
  }
  if (!skillExists(root, skill))
    return no(
      `extensions.merge.checks names "${skill}", but ${SKILL_DIR}/${skill}/SKILL.md is missing`,
    );
  let ledger;
  try {
    ledger = readLedger(root, id);
  } catch (error) {
    return no(error.message);
  }
  if (!ledger) return no(`no ledger for ${id}`, `lane merge ${id} --preflight [--branch <b>]`);
  lane.ledger = ledger;
  if (ledger.state === "merged") return no(`${id} is already landed; a check now changes nothing`);
  const tip = tipOf(lane);
  if (!tip) return no(`${ledger.branch} is not a local branch any more`);
  const note = opts["--note"];
  const entry = { result, ...(note !== undefined && { note }), tip, at: now() };
  save(lane, { checks: { ...(ledger.checks ?? {}), [skill]: entry } });
  const state = checksState(lane);
  const rows = [ok("check", `${skill}: ${result} on ${short(tip)}`), state.row];
  if (state.failed.length > 0) {
    const fix = `fix what ${state.failed.join(", ")} found on the branch, then record it again`;
    return done(0, lane, rows, fix);
  }
  const next = state.pending.length > 0 ? checkNext(id, state.pending) : landNext(id);
  return done(0, lane, rows, next);
}

export function pushMode(lane) {
  const refused = mergedLedger(lane, "push");
  if (refused) return refused;
  const { root, opts, ledger } = lane;
  const merge = ledger.merge;
  const config = readConfig(root);
  if (config.error) return done(2, lane, [red("push", config.error)]);
  const policy = config.merge.push;
  if (policy === "never") {
    const why = `merge.push is "never": the owner pushes, merge does not`;
    return done(2, lane, [red("push", why)], afterLand(lane));
  }
  if (policy === "ask" && !opts["--approved"]) {
    const why = `merge.push is "ask": ask the owner first, then pass --approved`;
    return done(2, lane, [red("push", why)]);
  }
  const main = mainRow(lane);
  if (main.mark === "red") return done(2, lane, [main]);
  const head = commitOf(root, "HEAD");
  const landedTip = merge.boardCommit ?? merge.landed.at(-1);
  if (!isAncestor(root, landedTip, head)) {
    const why = `${short(landedTip)} is not on ${ledger.mainBranch} any more`;
    return done(2, lane, [main, red("push", why)]);
  }
  if (merge.pushed?.head === head)
    return done(0, lane, [main, ok("push", `already pushed at ${short(head)}`)], afterLand(lane));
  const res = push(root, { branch: ledger.mainBranch });
  if (!res.ok) return done(1, lane, [main, red("push", res.reason)]);
  save(lane, {
    merge: { ...merge, pushed: { remote: res.remote, ref: res.ref, head, at: now() } },
  });
  const approved = policy === "ask" ? " (the owner approved)" : "";
  const detail = `${ledger.mainBranch} → ${res.remote} ${res.ref} at ${short(head)}${approved}`;
  return done(0, lane, [main, ok("push", detail)], afterLand(lane));
}

export function cleanupMode(lane) {
  const refused = mergedLedger(lane, "cleanup");
  if (refused) return refused;
  const { root, spec, id, opts, ledger } = lane;
  const merge = ledger.merge;
  if (merge.cleaned?.removed && merge.cleaned.branchDeleted) {
    const gone = `already done: ${merge.cleaned.path} and ${ledger.branch} are gone`;
    if (ledger.next) save(lane, { next: null });
    return done(0, lane, [ok("cleanup", gone)]);
  }
  const discard = Boolean(opts["--discard-ignored"]);
  const res = cleanup(root, {
    branch: ledger.branch,
    main: ledger.mainBranch,
    fallbackPath: ledger.worktree ?? join(worktreesDir(root), id),
    discardIgnored: discard,
    disposable: spec.cleanup?.disposable ?? [],
  });
  if (res.ignored && !discard)
    return done(
      2,
      lane,
      [red("cleanup", res.reason, res.ignored.slice(0, 10))],
      `copy what you need out of ${res.path}, then lane merge ${id} --cleanup --discard-ignored`,
    );
  const cleaned = {
    path: res.path,
    removed: res.removed,
    branchDeleted: res.branchDeleted,
    at: now(),
  };
  // Done: no next step is left, so a stale one (the cleanup itself) must not outlive it in the ledger.
  save(lane, { merge: { ...merge, cleaned }, ...(res.ok && { next: null }) });
  if (!res.ok) {
    const why = res.reason ?? "the worktree or the branch is still there";
    return done(1, lane, [red("cleanup", why)]);
  }
  const more = [
    ...(res.disposable ? [`discarded ${res.disposable.length} disposable path(s)`] : []),
    ...(res.ignored ? [`discarded ${res.ignored.length} ignored file(s)`] : []),
  ];
  const detail = `removed ${res.path}; deleted ${ledger.branch}`;
  return done(0, lane, [ok("cleanup", detail, more)], null);
}
