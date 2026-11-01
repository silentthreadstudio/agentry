// lane exec <step> <id> — the exec lane's stepper (plan R1b §3.2, ADR-R1): each step checks the ledger
// expects it, does the git and board work, records it and prints the next step as one JSON object
// `{ id, step, next, prompt?, brief?, reportPath, worktree, branch, guards, nested, … }`.
//
//   start <id>                cut `agentry/<id>` in a worktree, write `dispatched`, brief the builder
//   report <id> [--agent a]   read the builder's report, run the guards, brief the next round
//   verdict <id> [--agent a]  read the verifier's report, write the verdict, brief the next round
//   gate <id>                 run the repo's gate in the worktree and record it (exit 1 when red)
//   close <id> [--episode e]  print the episode payload; `--episode` stamps the id episode_write gave
//   show <id>                 the ledger and the pending step, for a cold resume
//
// Board writes go through `applyEvent` only (no `lifecycle` → none). Exit 0 = next printed, 1 = the lane
// stopped (or the gate is red), 2 = usage or refusal (nothing changed).
//
// run(argv, { root, spec, model }) -> { exit, out }
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "../../config.mjs";
import { findContract } from "../../process/contract.mjs";
import { worktrees } from "../../process/git.mjs";
import * as ledgers from "../../process/ledger.mjs";
import { applyEvent } from "../../process/lifecycle.mjs";
import { gateOf, own } from "../../process/spec.mjs";
import { WriteError } from "../../process/write.mjs";
import {
  bullets,
  citedDecisions,
  ownedFiles,
  recalledFacts,
  renderBrief,
  suggestBuilder,
} from "../brief.mjs";
import { changedSince, pickTier, runGate } from "../gate.mjs";
import { idProblem } from "../id.mjs";
import { builderStatus, summaryOf, usedMemories, verdictOf } from "../report.mjs";
import { DISPATCHES, addRound, step as advance, begin, expects, verdicts } from "../rounds.mjs";
import { create, git, mainRoot, porcelain, remove } from "../worktree.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LANE = join(HERE, "..", "..", "..", "lane.mjs");
const STEPS = ["start", "report", "verdict", "gate", "close", "show"];
export const usage = `exec <${STEPS.join("|")}> <id> [--agent <agent id>] [--episode <episode id>]`;
export const flags = { "--agent": true, "--episode": true };
const FLAG_OF = { report: "--agent", verdict: "--agent", close: "--episode" };

class Refusal extends Error {}
const refuse = (message) => {
  throw new Refusal(message);
};
const now = () => new Date().toISOString();
const short = (sha) => String(sha ?? "").slice(0, 7);
const q = (s) => `"${s}"`;
const laneLine = (root, sub, id, extra = "") =>
  `node ${q(LANE)} exec ${sub} ${id} --root ${q(root)}${extra}`;

// argv → { step, id, value } or { error }.
function parse(argv) {
  const words = [];
  let value = null;
  let flag = null;
  for (let i = 0; i < argv.length; i++) {
    if (!Object.hasOwn(flags, argv[i])) {
      words.push(argv[i]);
      continue;
    }
    if (flag) return { error: `${argv[i]} is given twice` };
    flag = argv[i];
    value = argv[++i];
    if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value` };
  }
  const [step, id, ...rest] = words;
  if (!STEPS.includes(step) || !id || rest.length) return { error: `usage: ${usage}` };
  if (flag && FLAG_OF[step] !== flag) return { error: `${step} takes no ${flag}` };
  return { step, id, value };
}

export function run(argv, ctx) {
  const { step, id, value, error } = parse(argv);
  if (error) return { exit: 2, out: error };
  const problem = idProblem(id);
  if (problem) return { exit: 2, out: problem };
  const root = realpathSync(ctx.root);
  const main = mainRoot(root);
  if (!main || realpathSync(main) !== root)
    return {
      exit: 2,
      out: `lane exec runs from the main checkout: pass --root ${main ?? "<the repository>"}`,
    };
  try {
    return HANDLERS[step]({ ...ctx, root }, id, value);
  } catch (e) {
    if (e instanceof Refusal || e instanceof WriteError) return { exit: 2, out: e.message };
    throw e;
  }
}

// ---- git facts ------------------------------------------------------------------------------------
//
// The main-touched guard is content-exact. `start` records the content id (git's blob id) of every
// file that is dirty in main, and each lifecycle write a lane makes records `{ file, from, to }` in its
// ledger (`boardWrites`). At a report, a main file may differ from the lane's start only when its
// content is reachable from its start content, or from the content a recorded merge committed, through
// recorded lifecycle writes. Any other edit (another row, free text, a non-board file, a file dirty at
// start that changed since) is the builder's. HEAD may move only by merges other ledgers record, each a
// run preHead → landed… → board commit that git's first-parent history confirms.

const RUN_DIR = ".agentry/run/";
const ABSENT = "-";
const headOf = (dir, ref = "HEAD") =>
  git(dir, ["rev-parse", "--verify", "--quiet", ref]).stdout.trim();

// Main's changed paths (Agentry's run files left out) → their `git status` entry; a rename or copy
// lists its source too.
function dirtyPaths(root) {
  const res = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (res.status !== 0) refuse(`git status failed in ${root}: ${res.stderr.trim()}`);
  const parts = res.stdout.split("\0").filter(Boolean);
  const out = new Map();
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const paths = [entry.slice(3), ...(/^[RC]/.test(entry) ? [parts[++i]] : [])];
    for (const path of paths) if (!path.startsWith(RUN_DIR)) out.set(path, entry);
  }
  return out;
}

// The blob id git would store for each path as it is in main's working tree, ABSENT when it is not
// a file there.
function contentOf(root, paths) {
  const out = Object.fromEntries(paths.map((p) => [p, ABSENT]));
  const files = paths.filter((p) => {
    try {
      return statSync(join(root, p)).isFile();
    } catch {
      return false;
    }
  });
  if (!files.length) return out;
  const res = git(root, ["hash-object", "--", ...files]);
  if (res.status !== 0) refuse(`git hash-object failed in ${root}: ${res.stderr.trim()}`);
  res.stdout
    .split("\n")
    .filter(Boolean)
    .forEach((id, i) => {
      out[files[i]] = id;
    });
  return out;
}

// The blob id of each path in `commit`, ABSENT when the commit has no such file.
function blobsAt(root, commit, paths) {
  const out = Object.fromEntries(paths.map((p) => [p, ABSENT]));
  const res = git(root, ["--literal-pathspecs", "ls-tree", "-r", "-z", commit, "--", ...paths]);
  for (const line of res.stdout.split("\0").filter(Boolean)) {
    const tab = line.indexOf("\t");
    const path = line.slice(tab + 1);
    if (Object.hasOwn(out, path)) out[path] = line.slice(0, tab).split(" ")[2];
  }
  return out;
}

/** What main looks like when a lane starts: HEAD, the `git status` entries and the content of each. */
function mainSnapshot(root) {
  const dirty = dirtyPaths(root);
  return {
    head: headOf(root),
    porcelain: [...new Set(dirty.values())],
    files: contentOf(root, [...dirty.keys()]),
  };
}

// The files a lifecycle event of this lane writes (relative to the git root).
function boardFiles(spec, model, id) {
  const life = spec.lifecycle;
  if (!life) return [];
  const kind = own(spec.kinds, life.kind);
  const item = own(model.kinds, life.kind)?.items.find((i) => i.id === id);
  const file = kind?.at?.table ?? item?.file;
  return file ? [posix.join(spec.root, file)] : [];
}

// Is `to` reachable from one of `from` through recorded writes?
function reachable(moves, from, to) {
  const seen = new Set(from);
  const queue = [...from];
  while (queue.length) {
    const at = queue.shift();
    if (at === to) return true;
    for (const m of moves)
      if (m.from === at && !seen.has(m.to)) {
        seen.add(m.to);
        queue.push(m.to);
      }
  }
  return false;
}

// The main files whose content no recorded lifecycle write explains, as `git status` entries.
function strayFiles(root, ledger, head, all) {
  const was = ledger.mainAtStart;
  const started = was.files ?? {};
  const dirty = dirtyPaths(root);
  const paths = [...new Set([...dirty.keys(), ...Object.keys(started)])];
  if (!paths.length) return [];
  const now = contentOf(root, paths);
  const atStart = blobsAt(root, was.head, paths);
  const atHead = head === was.head ? atStart : blobsAt(root, head, paths);
  const moves = all.flatMap((l) => l.boardWrites ?? []);
  return paths
    .filter((p) => {
      const start = Object.hasOwn(started, p) ? started[p] : atStart[p];
      if (now[p] === start) return false;
      const from = atHead[p] === atStart[p] ? [start] : [start, atHead[p]];
      return !reachable(
        moves.filter((m) => m.file === p),
        from,
        now[p],
      );
    })
    .map((p) => dirty.get(p) ?? `${p} (back to HEAD)`);
}

// Are main's first-parent commits from `from` to `to`, end to end, merges other ledgers record? Each
// must be the run preHead → landed… → board commit its ledger names, in that order, on git's own
// first-parent line: a ledger is trusted only as far as git confirms it.
function landedOnly(root, from, to, others) {
  const res = git(root, ["rev-list", "--first-parent", "--reverse", `${from}..${to}`, "--"]);
  const chain = res.stdout.split("\n").filter(Boolean);
  if (res.status !== 0 || !chain.length) return false;
  if (headOf(root, `${chain[0]}^`) !== from) return false;
  const runs = others
    .map((l) => l.merge)
    .filter((m) => typeof m?.preHead === "string" && Array.isArray(m.landed) && m.landed.length)
    .map((m) => ({
      preHead: m.preHead,
      shas: [...m.landed, ...(typeof m.boardCommit === "string" ? [m.boardCommit] : [])],
    }));
  let at = from;
  for (let i = 0; i < chain.length; ) {
    const run = runs.find((r) => r.preHead === at && r.shas.every((s, k) => chain[i + k] === s));
    if (!run) return false;
    i += run.shas.length;
    at = chain[i - 1];
  }
  return true;
}

// Why the main checkout no longer matches the lane's start, or null.
function mainTouched(root, ledger, all) {
  const was = ledger.mainAtStart;
  const head = headOf(root);
  const others = all.filter((l) => l.id !== ledger.id);
  const reasons = [];
  if (head !== was.head && !landedOnly(root, was.head, head, others))
    reasons.push(`HEAD moved ${short(was.head)} → ${short(head)}`);
  const stray = strayFiles(root, ledger, head, all);
  if (stray.length) reasons.push(`files changed: ${stray.slice(0, 10).join(", ")}`);
  return reasons.length ? reasons.join("; ") : null;
}

// Worktrees that appeared since the lane started and belong to no lane: a nested builder (#7).
function nestedTrees(root, ledger, all) {
  const known = new Set([root, ...ledger.worktreesAtStart, ...all.map((l) => l.worktree)]);
  const seen = worktrees(root)
    .map((t) => t.path)
    .filter((p) => !known.has(p));
  return [...new Set([...(ledger.nested ?? []), ...seen])];
}

// The lanes that count against `lanes.maxWriters`: open ledgers that build or fix, and worktrees no
// ledger owns (an agent's own worktree, or one made by hand).
function writers(root) {
  const all = ledgers.list(root);
  const owned = new Set(all.map((l) => l.worktree));
  return [
    ...all
      .filter((l) => l.state === "building" || l.state === "fixing")
      .map((l) => `${l.id} (${l.state}, ledger ${l.worktree})`),
    ...worktrees(root)
      .filter((t) => t.path !== root && !owned.has(t.path))
      .map((t) => `${t.path} (${t.branch ?? "detached"}, no ledger)`),
  ];
}

// ---- briefs ---------------------------------------------------------------------------------------

const contractFile = (root, id) => join(ledgers.runDir(root, id), "contract.md");

function gateLine(root, spec, ledger) {
  if (!gateOf(spec)) return "none: the process file has no gate, so run the repo's own checks";
  return `cd ${q(ledger.worktree)} && ${laneLine(root, "gate", ledger.id)}`;
}

function factsLine(root, owned, block) {
  const { prime, facts } = recalledFacts(root, { owned, block });
  if (prime !== "all") return `none (memory.prime is "${prime}": briefs carry no recalled facts)`;
  return bullets(
    facts.map((f) => {
      const body = f.body.replace(/\s+/g, " ");
      return `[${f.type ?? "fact"} · ${f.id ?? "?"}] ${body.length > 600 ? `${body.slice(0, 599)}…` : body}`;
    }),
  );
}

// Render the brief for `dispatch` as round `n` and return the round's files.
function brief({ root, spec, model }, ledger, dispatch) {
  const n = ledger.rounds.length + 1;
  const dir = ledgers.runDir(root, ledger.id);
  const name = `r${n}-${dispatch.step}`;
  const logDir = join(dir, "logs", `r${n}`);
  mkdirSync(logDir, { recursive: true });
  const block = readFileSync(contractFile(root, ledger.id), "utf8");
  const owned = ownedFiles(block);
  const builder = ledger.rounds.filter((r) => r.role === "build").at(-1);
  const tip = headOf(root, ledger.branch);
  const fresh = !dispatch.resend;
  const values = {
    id: ledger.id,
    round: n,
    contract: `${ledger.contract.file}:${ledger.contract.line}`,
    block: block.trimEnd(),
    owned: bullets(owned.map((p) => `\`${p}\``)),
    decisions: bullets(
      citedDecisions({ root, spec, model, block }).map((d) => `${d.id}: ${d.text}`),
    ),
    facts: factsLine(root, owned, block),
    worktree: ledger.worktree,
    branch: ledger.branch,
    base: short(ledger.base),
    mainRoot: root,
    logDir,
    reportPath: join(dir, `${name}.report.md`),
    gateLine: gateLine(root, spec, ledger),
    tip: short(tip),
    from: dispatch.from ?? "",
    reason: dispatch.reason ?? "",
    resend: !!dispatch.resend,
    recheck: dispatch.step === "recheck" && fresh,
    fail: dispatch.step === "fix" && !dispatch.guard && fresh,
    guard: !!dispatch.guard && fresh,
    needed: dispatch.step === "needs-context" && fresh,
    builderReport: builder?.reportPath ?? "none",
    earlier: verdicts(ledger)
      .map((r) => r.reportPath)
      .join(", "),
  };
  const file = join(dir, `${name}.md`);
  writeFileSync(file, renderBrief(dispatch.step, values));
  return { brief: file, reportPath: values.reportPath, tip, at: now() };
}

const dispatchNext = (ctx, ledger, dispatch) =>
  dispatch ? addRound(ledger, dispatch, brief(ctx, ledger, dispatch)) : ledger;

// ---- output ---------------------------------------------------------------------------------------

function view(root, ledger, { step, guards = [], nested = [], extra = {} }) {
  const round = ledger.rounds.at(-1);
  const out = {
    id: ledger.id,
    step,
    next: ledger.next,
    state: ledger.state,
    reportPath: round?.reportPath ?? null,
    worktree: ledger.worktree,
    branch: ledger.branch,
    guards,
    nested,
  };
  const waiting = expects(ledger);
  if (DISPATCHES.includes(ledger.next) && (waiting === "report" || waiting === "verdict")) {
    out.prompt = [
      `agentry-task: ${ledger.id} role=${round.role} round=${round.n}`,
      `Read your brief first: ${round.brief}. Work only in ${ledger.worktree}; prefix every shell command with \`cd ${ledger.worktree} &&\`.`,
    ].join("\n");
    out.brief = round.brief;
    out.role = round.role;
    out.mode = round.mode === "resume" && round.agent ? "resume" : "fresh";
    if (out.mode === "resume") out.agent = round.agent;
    out.dispatch =
      round.role === "verify" ? { agent: "verifier" } : suggestBuilder(ownedOf(root, ledger));
    if (round.step === "needs-context" && !round.resend)
      out.todo = `append the fact under "## The fact" at the end of ${round.brief} before sending it; if the contract, the repo and memory don't hold it, ask the owner first`;
    out.after = `${laneLine(root, waiting, ledger.id)} --agent <the agent's id>`;
  } else if (ledger.next === "gate" || ledger.next === "close") {
    out.run = laneLine(root, ledger.next, ledger.id);
  } else if (ledger.next === "merge") {
    out.run = `/agentry:merge ${ledger.id}`;
  }
  if (ledger.next === "stop") out.reason = ledger.stopReason ?? null;
  return {
    exit: ledger.next === "stop" ? 1 : 0,
    out: JSON.stringify({ ...out, ...extra }, null, 2),
  };
}

const ownedOf = (root, ledger) => ownedFiles(readFileSync(contractFile(root, ledger.id), "utf8"));

// ---- steps ----------------------------------------------------------------------------------------

function mustLedger(root, id) {
  let ledger;
  try {
    ledger = ledgers.read(root, id);
  } catch (e) {
    refuse(e.message);
  }
  if (!ledger) refuse(`no lane for ${id}: run ${laneLine(root, "start", id)}`);
  return ledger;
}

// One lifecycle event, and what it did to each file as `{ file, from, to }` content ids: the writes the
// main guard follows (`boardWrites` in the ledger).
function boardEvent(ctx, event, id, data) {
  const { root, spec, model } = ctx;
  const before = contentOf(root, boardFiles(spec, model, id));
  const board = applyEvent({ root, spec, model, event, id, data });
  const files = [...new Set(board.writes.map((w) => w.file))];
  const after = contentOf(root, files);
  return { board, moves: files.map((file) => ({ file, from: before[file], to: after[file] })) };
}

function start(ctx, id) {
  const { root, spec, model } = ctx;
  const existing = (() => {
    try {
      return ledgers.read(root, id);
    } catch (e) {
      return refuse(e.message);
    }
  })();
  if (existing)
    refuse(
      `a lane for ${id} exists (state ${existing.state}, next ${existing.next}): ${laneLine(root, "show", id)}`,
    );
  const config = readConfig(root);
  if (config.error) refuse(config.error);
  const open = writers(root);
  if (open.length >= config.lanes.maxWriters)
    refuse(
      `${open.length} writer(s) open, lanes.maxWriters is ${config.lanes.maxWriters}; finish or merge one first:\n${open.map((w) => `  ${w}`).join("\n")}`,
    );
  const kind = spec.lifecycle?.kind ?? "task";
  const found = findContract({ root, spec, id, kind });
  if (found.status !== "found") {
    const where = found.candidates.map((c) => `  ${c.file}:${c.line}`).join("\n");
    refuse(`contract ${id}: ${found.status}${where ? `\n${where}` : ""}`);
  }
  const mainBranch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
  if (!mainBranch) refuse("the main checkout is on a detached HEAD");
  const base = headOf(root);

  let tree;
  try {
    tree = create(root, { id, base });
  } catch (e) {
    refuse(e.message);
  }
  let board;
  let moves;
  try {
    ({ board, moves } = boardEvent(ctx, "dispatched", id));
  } catch (e) {
    remove(root, { ...tree, force: true });
    throw e;
  }
  writeFileSync(contractFile(root, id), `${found.block.trimEnd()}\n`);
  const at = now();
  let ledger = {
    v: 1,
    id,
    kind,
    contract: { file: found.file, line: found.line },
    origin: "exec",
    mainBranch,
    base,
    worktree: tree.path,
    branch: tree.branch,
    mainAtStart: mainSnapshot(root),
    worktreesAtStart: worktrees(root).map((t) => t.path),
    rounds: [],
    gates: [],
    checks: {},
    usedMemories: [],
    nested: [],
    boardWrites: moves,
    startedAt: at,
    state: "building",
    next: "build",
  };
  ledger = dispatchNext(ctx, ledger, begin().dispatch);
  ledgers.write(root, ledger);
  return view(root, ledger, { step: "start", extra: { board } });
}

function readReport(path, who) {
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

function stepWith(ledger, event) {
  try {
    return advance(ledger, event);
  } catch (e) {
    return refuse(`${e.message} (next is ${ledger.next})`);
  }
}

function report(ctx, id, agent) {
  const { root } = ctx;
  const ledger = mustLedger(root, id);
  if (expects(ledger) !== "report")
    refuse(
      `the lane expects ${expects(ledger) ?? "nothing"} now, not a report (next is ${ledger.next})`,
    );
  const round = ledger.rounds.at(-1);
  const text = readReport(round.reportPath, "builder");
  const all = ledgers.list(root);
  let dirty;
  try {
    dirty = porcelain(ledger.worktree);
  } catch (e) {
    refuse(`the worktree ${ledger.worktree} is not readable: ${e.message}`);
  }
  const count = git(root, ["rev-list", "--count", `${ledger.base}..${ledger.branch}`]);
  const guards = {
    mainTouched: mainTouched(root, ledger, all),
    dirty,
    commits: count.status === 0 ? Number(count.stdout.trim()) : 0,
  };
  const res = stepWith(ledger, {
    type: "report",
    status: builderStatus(text),
    report: round.reportPath,
    agent,
    summary: summaryOf(text),
    guards,
  });
  let next = res.ledger;
  next.usedMemories = [...new Set([...(next.usedMemories ?? []), ...usedMemories(text)])];
  next.nested = nestedTrees(root, next, all);
  const built = ["verify", "recheck"].includes(res.dispatch?.step)
    ? boardEvent(ctx, "built", id)
    : null;
  const board = built?.board ?? null;
  next.boardWrites = [...(next.boardWrites ?? []), ...(built?.moves ?? [])];
  next = dispatchNext(ctx, next, res.dispatch);
  ledgers.write(root, next);
  return view(root, next, {
    step: "report",
    guards: next.rounds.at(res.dispatch ? -2 : -1).guards ?? [],
    nested: next.nested,
    extra: { ...(res.reason && { why: res.reason }), ...(board && { board }) },
  });
}

function verdict(ctx, id, agent) {
  const { root, spec } = ctx;
  const ledger = mustLedger(root, id);
  if (expects(ledger) !== "verdict")
    refuse(
      `the lane expects ${expects(ledger) ?? "nothing"} now, not a verdict (next is ${ledger.next})`,
    );
  const round = ledger.rounds.at(-1);
  const text = readReport(round.reportPath, "verifier");
  const all = ledgers.list(root);
  const res = stepWith(ledger, {
    type: "verdict",
    verdict: verdictOf(text),
    report: round.reportPath,
    agent,
    summary: summaryOf(text),
    tip: headOf(root, ledger.branch),
    gate: gateOf(spec) !== null,
  });
  let next = res.ledger;
  next.usedMemories = [...new Set([...(next.usedMemories ?? []), ...usedMemories(text)])];
  next.nested = nestedTrees(root, next, all);
  const judged = next.rounds.at(-1);
  const written =
    judged.verdict && !judged.void
      ? boardEvent(ctx, "verdict", id, { verdict: judged.verdict })
      : null;
  const board = written?.board ?? null;
  next.boardWrites = [...(next.boardWrites ?? []), ...(written?.moves ?? [])];
  next = dispatchNext(ctx, next, res.dispatch);
  ledgers.write(root, next);
  return view(root, next, {
    step: "verdict",
    nested: next.nested,
    extra: {
      verdict: judged.void ? "void" : (judged.verdict ?? null),
      ...(res.reason && { why: res.reason }),
      ...(board && { board }),
    },
  });
}

function gate(ctx, id) {
  const { root, spec } = ctx;
  const ledger = mustLedger(root, id);
  if (ledger.state === "stopped" || ledger.next === "merge")
    refuse(`the lane is ${ledger.state} (next ${ledger.next}): no gate to run`);
  const config = gateOf(spec);
  if (!config) refuse("the process file has no gate: add one (/agentry:init) to run it here");
  const tier = pickTier(config, changedSince(ledger.worktree, ledger.base, "HEAD") ?? []);
  const command = tier.tier === "quick" ? config.quick.command : config.command;
  const logFile = join(
    ledgers.runDir(root, id),
    "logs",
    `gate-${(ledger.gates?.length ?? 0) + 1}.log`,
  );
  const ran = runGate(ledger.worktree, command, { tier: tier.tier, logFile });
  if (ran.refused)
    refuse(
      `the worktree is not clean, so the gate did not run: ${ran.files.slice(0, 10).join(", ")}`,
    );
  const record = { where: "worktree", ...ran, why: tier.reason, at: now() };
  const res = stepWith(ledger, { type: "gate", record });
  ledgers.write(root, res.ledger);
  const shown = view(root, res.ledger, {
    step: "gate",
    extra: {
      gate: {
        exit: ran.exit,
        tier: ran.tier,
        why: tier.reason,
        commit: short(ran.commit),
        seconds: ran.seconds,
        log: ran.log,
      },
      ...(res.reason && { why: res.reason }),
    },
  });
  return { ...shown, exit: ran.exit === 0 ? shown.exit : 1 };
}

// The `episode_write` arguments for this lane, from the ledger alone.
function episodeOf(ledger) {
  const judged = verdicts(ledger);
  const guardTrips = ledger.rounds.flatMap((r) => r.guards ?? []);
  const lastGate = ledger.gates?.at(-1);
  const what = ledger.rounds.find((r) => r.role === "build" && r.summary)?.summary;
  const outcome = [
    ledger.state === "stopped"
      ? `stopped: ${ledger.stopReason ?? "unknown"}`
      : `verified (${judged.at(-1)?.verdict})`,
    `rounds: ${ledger.rounds.map((r) => `${r.step}${r.resend ? " (resent)" : ""}`).join(", ")}`,
    `verdicts: ${judged.map((r) => r.verdict).join(", ") || "none"}`,
    `void verdicts: ${ledger.rounds.filter((r) => r.void).length}`,
    `guard trips: ${guardTrips.length ? guardTrips.join(" | ") : "none"}`,
    `worktree gate: ${lastGate ? `${lastGate.exit === 0 ? "green" : "red"} ${lastGate.tier} on ${short(lastGate.commit)}` : "none"}`,
    `nested worktrees: ${ledger.nested?.length ?? 0}`,
  ].join("; ");
  return {
    task: what ? `${ledger.id}: ${what}` : ledger.id,
    shape: "exec",
    outcome,
    retries: Math.max(0, ledger.rounds.filter((r) => r.role === "build").length - 1),
    usedMemories: ledger.usedMemories ?? [],
  };
}

function close(ctx, id, episodeId) {
  const { root } = ctx;
  let ledger = mustLedger(root, id);
  if (episodeId !== null) {
    if (!ledger.episode?.payload) refuse(`no episode to stamp: run ${laneLine(root, "close", id)}`);
    ledger = { ...ledger, episode: { ...ledger.episode, writtenId: episodeId } };
    ledgers.write(root, ledger);
    return {
      exit: 0,
      out: JSON.stringify({ id, step: "close", episode: ledger.episode }, null, 2),
    };
  }
  const closable = ledger.next === "close" || ledger.state === "stopped" || ledger.episode;
  if (!closable) refuse(`the lane is not done (state ${ledger.state}, next ${ledger.next})`);
  const payload = episodeOf(ledger);
  ledger = {
    ...ledger,
    episode: { ...ledger.episode, payload },
    ...(ledger.state === "verified" && { next: "merge" }),
  };
  ledgers.write(root, ledger);
  const shown = view(root, ledger, {
    step: "close",
    extra: {
      episode: payload,
      afterwards: `episode_write with this payload, then ${laneLine(root, "close", id, " --episode <its id>")}`,
    },
  });
  return { ...shown, exit: 0 };
}

function show(ctx, id) {
  const { root } = ctx;
  const ledger = mustLedger(root, id);
  const all = ledgers.list(root);
  return view(root, ledger, {
    step: "show",
    nested: nestedTrees(root, ledger, all),
    extra: {
      rounds: ledger.rounds.map((r) => ({
        n: r.n,
        step: r.step,
        mode: r.mode,
        ...(r.resend && { resend: true }),
        ...(r.agent && { agent: r.agent }),
        ...(r.status && { status: r.status }),
        ...(r.verdict && { verdict: r.verdict }),
        ...(r.void && { void: true }),
        ...(r.guards && { guards: r.guards }),
      })),
      gates: (ledger.gates ?? []).map((g) => ({
        exit: g.exit,
        tier: g.tier,
        commit: short(g.commit),
        log: g.log,
      })),
      ...(ledger.episode && { episode: ledger.episode }),
    },
  });
}

const HANDLERS = { start, report, verdict, gate, close, show };
