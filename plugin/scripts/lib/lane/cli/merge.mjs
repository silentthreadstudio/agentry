// lane merge <id> — land one task on main (plan R1b-5, F14): one procedure, stepped by the ledger.
//
//   merge <id> [--branch <b>] --preflight                what landing needs (adopts --branch work)
//   merge <id> --check <skill>=pass|fail [--note <t>]    record a repo check (extensions.merge.checks)
//   merge <id> [--branch <b>] --message <m> [--summary <t>]
//                                                        land → gate or skip → record → board commit
//   merge <id> --push [--approved]                       push per config merge.push (ask|auto|never)
//   merge <id> --cleanup [--discard-ignored]             the worktree and branch, found by branch
//
// `--branch` adopts work built outside exec: the ledger is created with origin "adopted". Each call
// prints a step table and the next step. Exit 0 = done, next printed; 1 = a red step stopped it (the
// row says why); 2 = usage or refusal. A call stops at its first red row and is idempotent from the
// ledger: re-running the land after a stop resumes from what the ledger says already happened.
//
// run(argv, { root, spec, model }) -> { exit, out }
import { existsSync, realpathSync } from "node:fs";
import { join, posix } from "node:path";
import { readConfig } from "../../config.mjs";
import { defaultBranch, worktrees } from "../../process/git.mjs";
import { read as readLedger, runDir, write as writeLedger } from "../../process/ledger.mjs";
import { applyEvent } from "../../process/lifecycle.mjs";
import { readProcess } from "../../process/read.mjs";
import { gateOf, own } from "../../process/spec.mjs";
import { boardReport } from "../../process/status.mjs";
import { WriteError } from "../../process/write.mjs";
import { canSkip, changedSince, pickTier, runGate } from "../gate.mjs";
import { idProblem } from "../id.mjs";
import {
  attributionIn,
  boardCommit,
  cherryPick,
  cleanup,
  commitOf,
  commitsBetween,
  currentBranch,
  isAncestor,
  mergeBaseOf,
  notEdits,
  push,
  putBack,
  restoreFiles,
  rollback,
  setAside,
  statusEntries,
  subjectOf,
  toLand,
  treeOf,
} from "../land.mjs";
import { findByBranch, mainRoot, porcelain, worktreesDir } from "../worktree.mjs";

export const usage = [
  "merge <id> [--branch <b>] --preflight",
  "merge <id> --check <skill>=pass|fail [--note <t>]",
  "merge <id> [--branch <b>] --message <board commit> [--summary <t>]",
  "merge <id> --push [--approved]",
  "merge <id> --cleanup [--discard-ignored]",
].join("\n       ");
export const flags = {
  "--preflight": false,
  "--check": true,
  "--note": true,
  "--branch": true,
  "--message": true,
  "--summary": true,
  "--push": false,
  "--approved": false,
  "--cleanup": false,
  "--discard-ignored": false,
};
// Each mode and the options that go with it.
const MODES = {
  "--preflight": ["--branch"],
  "--check": ["--note"],
  "--message": ["--branch", "--summary"],
  "--push": ["--approved"],
  "--cleanup": ["--discard-ignored"],
};
// The ledger states a land may start or resume from; an exec lane still building or verifying is not
// done, and a stopped one needs the owner.
const LANDABLE = ["verified", "merging", "merged"];
const CHECK_RESULTS = ["pass", "fail"];
const MARK = { ok: "✓", red: "✗", skip: "·", wait: "…" };
const short = (sha) => (sha ? sha.slice(0, 7) : "-");
const now = () => new Date().toISOString();
const row =
  (mark) =>
  (step, detail, more = []) => ({ step, mark, detail, more });
const ok = row("ok");
const red = row("red");
const skip = row("skip");
const wait = row("wait");

// argv → { id, mode, opts } or { error }.
function parse(argv) {
  const words = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!Object.hasOwn(flags, arg)) {
      words.push(arg);
      continue;
    }
    if (Object.hasOwn(opts, arg)) return { error: `${arg} is given twice` };
    if (!flags[arg]) {
      opts[arg] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) return { error: `${arg} needs a value` };
    opts[arg] = value;
  }
  if (words.length !== 1) return { error: `usage: ${usage}` };
  const modes = Object.keys(MODES).filter((m) => Object.hasOwn(opts, m));
  if (modes.length !== 1)
    return { error: `give exactly one of ${Object.keys(MODES).join(", ")}\nusage: ${usage}` };
  const [mode] = modes;
  const stray = Object.keys(opts).find((k) => k !== mode && !MODES[mode].includes(k));
  if (stray) return { error: `${stray} does not go with ${mode}` };
  return { id: words[0], mode, opts };
}

function render(lane, rows, next) {
  const head = lane.ledger
    ? `merge ${lane.id} · ${lane.ledger.branch} → ${lane.ledger.mainBranch}`
    : `merge ${lane.id}`;
  const body = rows.flatMap((r) => [
    `  ${MARK[r.mark]} ${r.step.padEnd(7)} ${r.detail}`,
    ...r.more.map((m) => `            ${m}`),
  ]);
  return [head, ...body, ...(next ? [`next: ${next}`] : [])].join("\n");
}
// The call's result; a next step it names is kept in the ledger too (`next`), for a cold resume.
function done(exit, lane, rows, next) {
  if (lane.ledger && next && lane.ledger.next !== next) save(lane, { next });
  return { exit, out: render(lane, rows, next) };
}

// Write the ledger with `changes` merged in, and keep the written copy on the lane.
function save(lane, changes = {}) {
  lane.ledger = writeLedger(lane.root, { ...lane.ledger, ...changes });
  return lane.ledger;
}

// The task's ledger, or one adopted from `--branch`. Returns a row, or { exit, rows } to stop.
function ledgerStep(lane, { adopt }) {
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
    mainAtStart: { head, porcelain: porcelain(root) },
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
const SKILL_DIR = ".claude/skills";
const skillExists = (root, name) => existsSync(join(root, SKILL_DIR, name, "SKILL.md"));
const tipOf = (lane) => commitOf(lane.root, `refs/heads/${lane.ledger.branch}`);
// A finding is "new" when its rule fails for an item it did not fail for before the board write. The
// message is not part of it (it often quotes the status the write just changed); a problem with no item
// is keyed by its message.
const findingKey = (f) =>
  JSON.stringify([f.rule ?? null, f.kind ?? null, f.id ?? null, f.id ? null : f.message]);
const lastWorktreeGate = (ledger) =>
  (ledger.gates ?? []).findLast((g) => g.where === "worktree") ?? null;
// The `after` glob a post-gate file matched, found with the gate's own matcher (a quick tier whose only
// glob is that one), so the table never names a glob the skip decision did not use.
const globOf = (file, globs) =>
  globs.find(
    (glob) => pickTier({ quick: { command: ["-"], only: [glob] } }, [file]).tier === "quick",
  );

const landNext = (id) =>
  `lane merge ${id} --message "<board commit message>" [--summary "<handoff text>"]`;
const checkNext = (id, names) =>
  names.map((name) => `lane merge ${id} --check ${name}=pass|fail [--note "<why>"]`).join("; ");

// What comes after a land: the push the policy allows, else the cleanup.
function afterLand(lane) {
  const { id, root, ledger } = lane;
  if (ledger.merge?.cleaned?.removed) return null;
  if (ledger.merge?.pushed) return `lane merge ${id} --cleanup`;
  const config = readConfig(root);
  if (config.error) return `fix the config (${config.error}), then lane merge ${id} --push`;
  if (config.merge.push === "auto") return `lane merge ${id} --push`;
  if (config.merge.push === "ask")
    return `ask the owner to push ${ledger.mainBranch}; on yes: lane merge ${id} --push --approved`;
  return `lane merge ${id} --cleanup (merge.push is "never": the owner pushes)`;
}

function boardRow({ spec, model, id }) {
  const life = spec.lifecycle;
  if (!life) return skip("board", "lifecycle off: the merge writes nothing to the board");
  const items = (own(model.kinds, life.kind)?.items ?? []).filter((item) => item.id === id);
  if (items.length !== 1)
    return red("board", `${items.length ? "several" : "no"} ${life.kind} "${id}" on the board`);
  const to = own(life.on, "merged") ?? "-";
  return ok("board", `${life.kind} ${id} is "${items[0].status ?? ""}"; landing makes it "${to}"`);
}

// The board files the lifecycle's own status, verdict and commit writes go to (repo-relative): the
// lifecycle kind's table file, or the item's own file for a one-file-per-item kind. Exec leaves its
// writes there uncommitted on main; the land carries them into its board commit.
function lifecycleFiles({ spec, model, id }) {
  const life = spec.lifecycle;
  const write = life?.write ?? {};
  if (!life || !["status", "verdict", "commit"].some((key) => Object.hasOwn(write, key))) return [];
  const kind = spec.kinds[life.kind];
  if (kind.at.table !== undefined) return [posix.join(spec.root, kind.at.table)];
  const item = (own(model.kinds, life.kind)?.items ?? []).find((i) => i.id === id);
  return item?.file ? [posix.join(spec.root, item.file)] : [];
}

// Main's checkout: on the main branch and clean. With `carry`, plain edits of the lifecycle's board
// files are allowed too (exec's uncommitted writes) and listed in `lane.carried`; anything else refuses.
function mainRow(lane, { carry = false } = {}) {
  const { root, ledger } = lane;
  lane.carried = [];
  const on = currentBranch(root);
  if (on !== ledger.mainBranch)
    return red(
      "main",
      `the main checkout is on ${on ?? "a detached HEAD"}, not ${ledger.mainBranch}`,
    );
  const entries = statusEntries(root);
  if (!entries) return red("main", "git status failed in the main checkout");
  const board = carry ? lifecycleFiles(lane) : [];
  const dirty = notEdits(entries, board);
  if (dirty.length > 0) {
    const ours = dirty.some((entry) => entry.slice(3).startsWith(".agentry/run/"));
    const allowed = board.length ? [`only edits of ${board.join(", ")} may wait for the land`] : [];
    return red("main", `${ledger.mainBranch} is not clean: ${dirty.length} change(s)`, [
      ...dirty.slice(0, 10),
      ...allowed,
      ...(ours ? ["add .agentry/run/ to .gitignore: the lane's own files live there"] : []),
    ]);
  }
  lane.carried = entries.map((entry) => entry.slice(3));
  const at = `${ledger.mainBranch} at ${short(commitOf(root, "HEAD"))}`;
  if (lane.carried.length === 0) return ok("main", `${at}, clean`);
  return ok("main", `${at}, clean but for the lifecycle's uncommitted board writes`, [
    `${lane.carried.join(", ")}: carried into the board commit`,
  ]);
}

// Set exec's uncommitted board writes aside so the picks, the gate and a rollback see a clean tree.
function carryStep(lane, rows) {
  if (lane.carried.length === 0) return null;
  const patchFile = join(runDir(lane.root, lane.id), "merge-carry.patch");
  const aside = setAside(lane.root, { files: lane.carried, patchFile });
  if (!aside.ok) {
    rows.push(red("carry", `could not set the board writes aside: ${aside.reason}`));
    return { exit: 1 };
  }
  lane.carry = { files: lane.carried, patchFile };
  rows.push(ok("carry", `${lane.carried.length} board file(s) set aside (${patchFile})`));
  return null;
}

// After a stop, give main back the board writes it had before the land, uncommitted as they were.
function returnCarry(lane) {
  const { carry, root } = lane;
  if (!carry || carry.lost) return null;
  restoreFiles(root, carry.files);
  const back = putBack(root, carry);
  lane.carry = null;
  return back.ok
    ? ok("carry", "the lifecycle's board writes are back on main, uncommitted")
    : red("carry", `could not put the board writes back (${back.reason}): ${carry.patchFile}`);
}

// The commits to land, as a row: red when there is nothing to pick or a merge commit is in the way.
function commitsRow({ root, ledger }) {
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
          ? `every commit of ${branch} is already on ${mainBranch} (same patch): nothing to land; board fix records a hand merge`
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

// The repo checks: each named skill must exist (exit 2) and have an outcome recorded on the branch's
// current tip; `pending` lists the ones to record, `failed` the ones recorded as fail.
function checksState(lane) {
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

function pushRow({ root }) {
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

// --- the land: land → gate or skip → record → commit, each resumable from the ledger -------------

function landStep(lane, rows) {
  const { root } = lane;
  const { mainBranch, branch } = lane.ledger;
  const merge = lane.ledger.merge;
  if (merge && (merge.step === "landed" || merge.step === "gated")) {
    const chain = commitsBetween(root, merge.preHead, "HEAD", { firstParent: true });
    if (chain?.join(" ") !== merge.landed.join(" ")) {
      rows.push(
        red(
          "land",
          `${mainBranch} moved since ${merge.landed.length} commit(s) landed on ${short(merge.preHead)}; not guessing`,
        ),
      );
      return {
        exit: 1,
        next: `look at ${mainBranch} by hand (its log since ${short(merge.preHead)})`,
      };
    }
    rows.push(
      ok(
        "land",
        `${merge.landed.length} commit(s) already on ${mainBranch}: resuming`,
        merge.landed.map(short),
      ),
    );
    return null;
  }
  const { plan, row } = commitsRow(lane);
  if (row.mark === "red") {
    rows.push({ ...row, step: "land" });
    return { exit: 1 };
  }
  const preHead = commitOf(root, "HEAD");
  const tip = tipOf(lane);
  const res = cherryPick(root, { shas: plan.picks, preHead });
  if (!res.ok) {
    save(lane, {
      merge: { preHead, landed: [], tip, step: "conflict", stopped: res.stopped, at: now() },
    });
    const where = res.stopped ? ` on ${short(res.stopped)}` : "";
    rows.push(
      red("land", `cherry-pick stopped${where}: ${res.reason}`, [
        res.restored
          ? `aborted: ${mainBranch} is back at ${short(preHead)}, clean`
          : `aborted, but ${mainBranch} is NOT back at ${short(preHead)} and clean: check it by hand`,
      ]),
    );
    return {
      exit: 1,
      next: res.restored
        ? `ask the builder to rebase ${branch} onto ${mainBranch}, then land again`
        : null,
    };
  }
  // The lane's state before this land, given back if a red gate takes the picks off main again.
  const { state } = lane.ledger;
  const stateBefore = state === "merging" ? (lane.ledger.merge?.stateBefore ?? state) : state;
  save(lane, {
    state: "merging",
    merge: { preHead, landed: res.landed, tip, stateBefore, step: "landed", at: now() },
  });
  const more = res.landed.map((sha) => `${short(sha)} ${subjectOf(root, sha)}`);
  rows.push(ok("land", `${res.landed.length} commit(s) picked onto ${short(preHead)}`, more));
  return null;
}

function gateStep(lane, rows) {
  const { root, id, gate } = lane;
  const { mainBranch, branch, gates = [] } = lane.ledger;
  const merge = lane.ledger.merge;
  if (merge.step === "gated") {
    rows.push(ok("gate", `already passed: ${merge.gate.detail}`));
    return null;
  }
  const record = lastWorktreeGate(lane.ledger);
  const since = record ? changedSince(root, record.commit, merge.tip) : null;
  const decision = canSkip({
    record,
    mainTree: treeOf(root, "HEAD"),
    branchTipTree: treeOf(root, merge.tip),
    changedSinceGate: since,
    after: gate.after,
  });
  if (decision.skip) {
    const detail = `skipped: gate on ${short(record.commit)}, tree identical`;
    const more = [
      decision.reason,
      ...since.map((file) => `${file} matched after "${globOf(file, gate.after)}"`),
    ];
    save(lane, {
      merge: { ...merge, step: "gated", gate: { tier: "skipped", trusted: record.commit, detail } },
    });
    rows.push(ok("gate", detail, more));
    return null;
  }
  const { tier, reason } = pickTier(gate, changedSince(root, merge.preHead, "HEAD") ?? []);
  const n = gates.filter((g) => g.where === "main").length + 1;
  const logFile = join(runDir(root, id), `merge-gate-${n}.log`);
  const res = runGate(root, tier === "quick" ? gate.quick.command : gate.command, {
    tier,
    logFile,
  });
  if (res.refused) {
    rows.push(red("gate", `refused: ${mainBranch} is not clean`, res.files.slice(0, 10)));
    return { exit: 1 };
  }
  save(lane, { gates: [...gates, { where: "main", ...res, at: now() }] });
  const why = [`${tier}: ${reason}`, `not skipped: ${decision.reason}`, `log ${logFile}`];
  if (res.exit === 0) {
    const detail = `${tier} ran on ${mainBranch}: exit 0 in ${res.seconds} s`;
    save(lane, { merge: { ...merge, step: "gated", gate: { tier, detail, log: logFile } } });
    rows.push(ok("gate", detail, why));
    return null;
  }
  rows.push(red("gate", `${tier} ran on ${mainBranch}: exit ${res.exit} in ${res.seconds} s`, why));
  const back = rollback(root, { preHead: merge.preHead, landed: merge.landed });
  save(lane, {
    ...(back.ok && { state: merge.stateBefore }),
    merge: { ...merge, step: back.ok ? "rolled-back" : "rollback-refused", at: now() },
  });
  if (!back.ok) {
    rows.push(red("rollback", back.reason));
    return { exit: 1, next: `${mainBranch} still holds the landed commits: look at it by hand` };
  }
  rows.push(ok("rollback", `${mainBranch} reset to ${short(merge.preHead)}: the picks are off it`));
  return { exit: 1, next: `read the log, fix on ${branch} (resume the builder), then land again` };
}

function recordStep(lane, rows) {
  const { root, spec, id } = lane;
  const merge = lane.ledger.merge;
  lane.files = [];
  if (!spec.lifecycle) {
    rows.push(skip("record", "lifecycle off: nothing written to the board"));
    return null;
  }
  if (lane.carry) {
    // Exec's writes go back first, on top of the picks, so the merged write and the check see them.
    const back = putBack(root, lane.carry);
    if (!back.ok) {
      lane.carry.lost = true;
      rows.push(
        red("record", `the set-aside board writes no longer apply: ${back.reason}`, [
          `they are kept in ${lane.carry.patchFile}`,
        ]),
      );
      return { exit: 1, next: "re-apply that patch or redo the writes, then land again" };
    }
  }
  const model = readProcess({ root, spec });
  const before = new Set(boardReport({ root, spec, model }).findings.map(findingKey));
  const summary = lane.opts["--summary"] ?? subjectOf(root, merge.landed[0]);
  let result;
  try {
    result = applyEvent({
      root,
      spec,
      model,
      event: "merged",
      id,
      data: { shas: merge.landed, summary },
    });
  } catch (error) {
    if (!(error instanceof WriteError)) throw error;
    rows.push(red("record", error.message));
    return { exit: 1, next: "fix what it names, then land again (the picks stay; it resumes)" };
  }
  const carried = lane.carry?.files ?? [];
  lane.files = [...new Set([...result.writes.map((w) => w.file), ...carried])];
  const after = boardReport({ root, spec, model: readProcess({ root, spec }) });
  const fresh = after.findings.filter((f) => !before.has(findingKey(f)));
  if (fresh.length > 0) {
    const back = restoreFiles(root, lane.files);
    const restored = back.ok ? "the written files are restored" : `restore failed: ${back.reason}`;
    rows.push(
      red(
        "record",
        `board check: ${fresh.length} new finding(s) after the board write; ${restored}`,
        fresh.map((f) => `${f.rule} ${f.id ?? ""} ${f.message}`),
      ),
    );
    return {
      exit: 1,
      next: "fix what the finding names, then land again (the picks stay; it resumes)",
    };
  }
  const more = [
    ...result.writes.map((w) => `${w.file}: ${w.what}`),
    ...result.skipped.map((s) => `skipped ${s.what}: ${s.why}`),
  ];
  if (carried.length > 0) more.push(`carried, uncommitted until now: ${carried.join(", ")}`);
  rows.push(
    ok("record", `${result.writes.length} board write(s); board check: no new findings`, more),
  );
  return null;
}

function commitStep(lane, rows) {
  const { root, files } = lane;
  const merge = lane.ledger.merge;
  if (files.length === 0) {
    save(lane, {
      state: "merged",
      merge: { ...merge, step: "committed", boardCommit: null, at: now() },
    });
    rows.push(skip("commit", "nothing written to the board, nothing to commit"));
    return null;
  }
  const res = boardCommit(root, { files, message: lane.opts["--message"] });
  if (!res.ok) {
    const back = restoreFiles(root, files);
    const [head, ...rest] = res.reason.split("\n");
    rows.push(
      red("commit", head, [
        ...rest.slice(0, 10),
        back.ok ? "the board files are restored" : `restore failed: ${back.reason}`,
      ]),
    );
    return {
      exit: 1,
      next: "fix the message or what the hook names, then land again (it resumes)",
    };
  }
  lane.carry = null; // the carried board writes are in this commit now
  save(lane, {
    state: "merged",
    merge: { ...merge, step: "committed", boardCommit: res.sha, at: now() },
  });
  if (res.left.length > 0) {
    rows.push(
      red(
        "commit",
        `${short(res.sha)} committed, but main is not clean after it`,
        res.left.slice(0, 10),
      ),
    );
    return { exit: 1, next: "look at what the commit left behind (a hook that writes files?)" };
  }
  rows.push(
    ok("commit", `${short(res.sha)} ${subjectOf(root, res.sha)}`, [`files: ${files.join(", ")}`]),
  );
  return null;
}

// --- the five modes ------------------------------------------------------------------------------

function preflight(lane) {
  const got = ledgerStep(lane, { adopt: true });
  if (got.exit) return done(got.exit, lane, got.rows);
  const rows = [got];
  if (lane.ledger.state === "merged") {
    rows.push(ok("land", `already merged (board commit ${short(lane.ledger.merge?.boardCommit)})`));
    return done(0, lane, rows, afterLand(lane));
  }
  rows.push(boardRow(lane), mainRow(lane, { carry: true }), commitsRow(lane).row);
  const gate = gateOf(lane.spec);
  if (!gate) rows.push(red("gate", "the process file has no gate: merge cannot prove main"));
  else {
    const { root, ledger } = lane;
    const base = mergeBaseOf(root, ledger.mainBranch, ledger.branch);
    const changed = (base && changedSince(root, base, ledger.branch)) || [];
    const { tier, reason } = pickTier(gate, changed);
    const record = lastWorktreeGate(ledger);
    rows.push(
      ok("gate", `${tier} would run (${reason})`, [
        record
          ? `worktree gate: ${record.tier} exit ${record.exit} on ${short(record.commit)}; the land skips only when canSkip holds`
          : "no worktree gate recorded: the land runs the gate on main",
      ]),
    );
  }
  const checks = checksState(lane);
  rows.push(checks.row);
  if (checks.exit) return done(2, lane, rows);
  rows.push(pushRow(lane));
  if (rows.some((r) => r.mark === "red"))
    return done(1, lane, rows, `fix the red row(s), then lane merge ${lane.id} --preflight`);
  const next = checks.pending.length > 0 ? checkNext(lane.id, checks.pending) : landNext(lane.id);
  return done(0, lane, rows, next);
}

function land(lane) {
  const { id, opts } = lane;
  const message = opts["--message"];
  if (!message.trim())
    return { exit: 2, out: "--message is empty: give the board commit's message" };
  const credit = attributionIn(message);
  if (credit)
    return {
      exit: 2,
      out: `the board commit message carries AI attribution ("${credit}"): commits carry the author only`,
    };
  const got = ledgerStep(lane, { adopt: true });
  if (got.exit) return done(got.exit, lane, got.rows);
  const rows = [got];
  const merged = lane.ledger.merge;
  if (lane.ledger.state === "merged") {
    rows.push(
      ok("land", `already merged: ${merged.landed.map(short).join(" ")}`, [
        `board commit ${short(merged.boardCommit)}`,
      ]),
    );
    return done(0, lane, rows, afterLand(lane));
  }
  lane.gate = gateOf(lane.spec);
  if (!lane.gate) {
    rows.push(red("gate", "the process file has no gate: merge cannot prove main"));
    return done(2, lane, rows, "add a gate to the process file (/agentry:init)");
  }
  const board = boardRow(lane);
  rows.push(board);
  if (board.mark === "red") return done(2, lane, rows);
  const checks = checksState(lane);
  rows.push(checks.row);
  if (checks.exit) return done(2, lane, rows);
  if (checks.failed.length > 0)
    return done(1, lane, rows, `fix what ${checks.failed.join(", ")} found, then record it again`);
  if (checks.pending.length > 0) return done(2, lane, rows, checkNext(id, checks.pending));
  const main = mainRow(lane, { carry: true });
  rows.push(main);
  if (main.mark === "red") return done(2, lane, rows);
  for (const step of [carryStep, landStep, gateStep, recordStep, commitStep]) {
    const stop = step(lane, rows);
    if (!stop) continue;
    const back = returnCarry(lane);
    if (back) rows.push(back);
    return done(stop.exit, lane, rows, stop.next);
  }
  return done(0, lane, rows, afterLand(lane));
}

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

function check(lane) {
  const { root, spec, id, opts } = lane;
  const value = opts["--check"];
  const at = value.lastIndexOf("=");
  const [skill, result] = at > 0 ? [value.slice(0, at), value.slice(at + 1)] : [value, ""];
  if (!CHECK_RESULTS.includes(result))
    return { exit: 2, out: `--check takes <skill>=pass|fail, not "${value}"` };
  const names = spec.extensions?.merge?.checks ?? [];
  if (!names.includes(skill)) {
    const named = names.length ? names.join(", ") : "none named";
    return { exit: 2, out: `"${skill}" is not in extensions.merge.checks (${named})` };
  }
  if (!skillExists(root, skill))
    return {
      exit: 2,
      out: `extensions.merge.checks names "${skill}", but ${SKILL_DIR}/${skill}/SKILL.md is missing`,
    };
  let ledger;
  try {
    ledger = readLedger(root, id);
  } catch (error) {
    return { exit: 2, out: error.message };
  }
  if (!ledger)
    return {
      exit: 2,
      out: `no ledger for ${id}: run lane merge ${id} --preflight [--branch <b>] first`,
    };
  lane.ledger = ledger;
  if (ledger.state === "merged")
    return { exit: 2, out: `${id} is already landed; a check now changes nothing` };
  const tip = tipOf(lane);
  if (!tip) return { exit: 2, out: `${ledger.branch} is not a local branch any more` };
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

function pushMode(lane) {
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

function cleanupMode(lane) {
  const refused = mergedLedger(lane, "cleanup");
  if (refused) return refused;
  const { root, id, opts, ledger } = lane;
  const merge = ledger.merge;
  if (merge.cleaned?.removed && merge.cleaned.branchDeleted) {
    const gone = `already done: ${merge.cleaned.path} and ${ledger.branch} are gone`;
    return done(0, lane, [ok("cleanup", gone)]);
  }
  const discard = Boolean(opts["--discard-ignored"]);
  const res = cleanup(root, {
    branch: ledger.branch,
    main: ledger.mainBranch,
    fallbackPath: ledger.worktree ?? join(worktreesDir(root), id),
    discardIgnored: discard,
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
  save(lane, { merge: { ...merge, cleaned } });
  if (!res.ok) {
    const why = res.reason ?? "the worktree or the branch is still there";
    return done(1, lane, [red("cleanup", why)]);
  }
  const more = res.ignored ? [`discarded ${res.ignored.length} ignored file(s)`] : [];
  const detail = `removed ${res.path}; deleted ${ledger.branch}`;
  return done(0, lane, [ok("cleanup", detail, more)], null);
}

const RUN = {
  "--preflight": preflight,
  "--check": check,
  "--message": land,
  "--push": pushMode,
  "--cleanup": cleanupMode,
};

export function run(argv, { root, spec, model }) {
  const parsed = parse(argv);
  if (parsed.error) return { exit: 2, out: parsed.error };
  const problem = idProblem(parsed.id);
  if (problem) return { exit: 2, out: problem };
  const main = mainRoot(root);
  if (!main || main !== realpathSync(root))
    return {
      exit: 2,
      out: `run merge from the main checkout${main ? ` (${main})` : ""}, not ${root}`,
    };
  const lane = { root, spec, model, id: parsed.id, opts: parsed.opts, ledger: null, files: [] };
  return RUN[parsed.mode](lane);
}
