// lane exec <step> <id> — the exec lane's stepper (plan R1b §3.2, ADR-R1): each step checks the ledger
// expects it, does the git and board work, records it and prints the next step as readable text, or with
// `--json` as one object `{ id, step, next, prompt?, brief?, reportPath, worktree, branch, guards, nested, … }`.
//
//   start <id>                cut `agentry/<id>` in a worktree, write `dispatched`, brief the builder
//   report <id> [--agent a]   read the builder's report, run the guards, brief the next round
//   verdict <id> [--agent a]  read the verifier's report, write the verdict, brief the next round
//   gate <id>                 run the repo's gate in the worktree and record it (exit 1 when red)
//   fix <id> --notes N1,N3    a verified lane (PASS WITH NOTES): a builder round on those notes, then recheck
//   close <id> [--episode e]  print the episode payload; `--episode` stamps the id episode_write gave
//                             (and says whether the memory store holds it)
//   show <id>                 the ledger and the pending step, for a cold resume
//   owns <id> [--set a,b]     the owned files the briefs name (parsed once at start); `--set … --apply`
//                             replaces them, and the brief waiting to be answered is rewritten
//   hold <id> --for owner|later [--agent a]   a builder's round waits for the owner's review (its reply
//                             saved), or is parked (its builder stopped); the ledger alone is written
//   resume <id> --note "<the OK>" [--redo] [--fresh]   the owner's answer to a hold, then the next round
//
// Board writes go through `applyEvent` only (no `lifecycle` → none). Exit 0 = next printed, 1 = the lane
// stopped (or the gate is red), 2 = usage or refusal (nothing changed).
//
// run(argv, { root, spec, model }) -> { exit, out }
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PREVIEW, flagsOf, say, usageError } from "../../cli/help.mjs";
import { prefix } from "../../cli/invoke.mjs";
import { readConfig } from "../../config.mjs";
import { episodeStored } from "../../memory/episodes.mjs";
import { contentOf as contentIds, recordedSince } from "../../process/board-writes.mjs";
import { findContract } from "../../process/contract.mjs";
import { worktrees } from "../../process/git.mjs";
import { kindOf, runId } from "../../process/ids.mjs";
import { isKept } from "../../process/keep.mjs";
import * as ledgers from "../../process/ledger.mjs";
import { applyEvent } from "../../process/lifecycle.mjs";
import { own } from "../../process/spec/shape.mjs";
import {
  flaggedItem,
  gateOf,
  lifecycleOf,
  modelFor,
  verifyRoute,
} from "../../process/spec/workflow.mjs";
import { WriteError } from "../../process/write.mjs";
import {
  appendedAfter,
  bullets,
  citedDecisions,
  notesSection,
  ownedFiles,
  policySlots,
  shellQuote as q,
  recalledFacts,
  relatedNotes,
  renderBrief,
  stepSlots,
  suggestBuilder,
  unknownCites,
  withNew,
} from "../brief.mjs";
import {
  answerLabel,
  answerLine,
  answerText,
  heldText,
  humanView,
  ownedMark,
  routeText,
} from "../exec-view.mjs";
import { gateLockDir, holdGate } from "../gate-lock.mjs";
import { changedSince, flakyReds, globMatch, pickTier, runGate } from "../gate.mjs";
import { idProblem } from "../id.mjs";
import { idleOf } from "../idle.mjs";
import { commitsBetween } from "../land.mjs";
import { dirtyEntries, isMemoryCommit } from "../own-memory.mjs";
import { builderStatus, summaryOf, usedMemories, verdictOf } from "../report.mjs";
import {
  DISPATCHES,
  addRound,
  step as advance,
  begin,
  expects,
  gateTally,
  greenOn,
  notesBudget,
  skipsVerifier,
  verdicts,
} from "../rounds.mjs";
import { brokenIn, rulesOf } from "../subjects.mjs";
import { create, git, mainRoot, porcelain, remove } from "../worktree.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LANE = join(HERE, "..", "..", "..", "lane.mjs");
const STEPS = [
  "start",
  "report",
  "verdict",
  "gate",
  "fix",
  "close",
  "show",
  "owns",
  "hold",
  "resume",
];
export const help = {
  usage: `exec <${STEPS.join("|")}> <id> [--agent <agent id>] [--episode <episode id>] [--notes <N1,N3>] [--cite <A40,A41>] [--set <paths>] [--apply] [--for <owner|later>] [--evidence <path>] [--note <text>] [--redo] [--fresh] [--json]`,
  purpose: "Step one task's build lane: worktree, briefs, rounds, gate, episode. Prints text.",
  args: {
    start: "cut agentry/<id> in a worktree, write dispatched, brief the builder",
    report: "read the builder's report, run the guards, brief the next round",
    verdict: "read the verifier's report, write the verdict, brief the next round",
    gate: "run the repo's gate in the worktree and record it",
    fix: "after PASS WITH NOTES: a builder round on the named notes, then a recheck",
    close: "print the episode payload (--episode stamps the id episode_write gave)",
    show: "the ledger and the pending step, for a cold resume",
    owns: "the owned files every brief names, parsed once at start (--set replaces them)",
    hold: "a builder's round waits for the owner (--for owner), or is parked (--for later)",
    resume: "the owner's answer to a hold (--note), then the next round",
    "<id>": "the task's id, any case",
  },
  flags: {
    "--agent <agent id>":
      "report and verdict: the agent that answered, so a later round resumes it; hold: the builder out on the round",
    "--episode <episode id>": "close: the id episode_write returned",
    "--notes <N1,N3>": "fix: the verifier's notes to fix, by their labels",
    "--cite <A40,A41>":
      "start: decisions to quote in every brief, by id (rows naming the task are quoted anyway)",
    "--set <paths>": "owns: the comma-separated owned files to use from now on",
    "--apply": "owns: write the --set list (without it the new list is only shown)",
    "--for <owner|later>":
      "hold: the owner reviews the round (its reply saved), or later: the lane is parked",
    "--evidence <path>": "hold --for owner: what the owner opens (default: the round's report)",
    "--note <text>": "resume: the owner's words; hold --for later: why the lane is parked",
    "--redo": "resume: the owner sent the finished run back: build the same steps again",
    "--fresh": "resume: a fresh builder with the same brief (the held round's agent is gone)",
    "--json": "print the step's one JSON object instead of the readable text",
  },
  exits: { 0: "next printed", 1: "the lane stopped, or the gate is red", 2: "usage or refusal" },
  example: "lane exec owns T-4 --set src/a.ts,src/a.test.ts --apply",
};
const flags = flagsOf(help);
const STEPS_OF = {
  "--agent": ["report", "verdict", "hold"],
  "--episode": ["close"],
  "--notes": ["fix"],
  "--cite": ["start"],
  "--set": ["owns"],
  "--apply": ["owns"],
  "--for": ["hold"],
  "--evidence": ["hold"],
  "--note": ["hold", "resume"],
  "--redo": ["resume"],
  "--fresh": ["resume"],
};

class Refusal extends Error {}
const refuse = (message) => {
  throw new Refusal(message);
};
const now = () => new Date().toISOString();
const short = (sha) => String(sha ?? "").slice(0, 7);
const laneLine = (root, sub, id, extra = "") =>
  `${prefix("lane", `node ${q(LANE)}`)} exec ${sub} ${id} --root ${q(root)}${extra}`;

// argv → { step, id, value, set, cite, apply, json, holdFor, evidence, note, redo, fresh } or { error }.
// `value` is the --agent / --episode / --notes value.
function parse(argv) {
  const words = [];
  const given = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!Object.hasOwn(flags, flag)) {
      words.push(flag);
      continue;
    }
    if (Object.hasOwn(given, flag)) return { error: `${flag} is given twice` };
    given[flag] = true;
    if (flags[flag]) {
      given[flag] = argv[++i];
      if (given[flag] === undefined || given[flag].startsWith("--"))
        return { error: `${flag} needs a value` };
    }
  }
  const [step, id, ...rest] = words;
  if (!STEPS.includes(step) || !id || rest.length)
    return { error: `needs <${STEPS.join("|")}> <id>` };
  for (const flag of Object.keys(given))
    if (flag !== "--json" && !STEPS_OF[flag].includes(step))
      return { error: `${step} takes no ${flag}` };
  if (step === "fix" && given["--notes"] === undefined) return { error: "fix needs --notes N1,N3" };
  if (given["--apply"] && given["--set"] === undefined)
    return { error: "--apply writes the --set list: give --set <paths>" };
  return {
    step,
    id,
    value: given["--agent"] ?? given["--episode"] ?? given["--notes"] ?? null,
    set: given["--set"] ?? null,
    cite: given["--cite"]?.split(",").map((c) => c.trim()) ?? [],
    apply: Boolean(given["--apply"]),
    json: Boolean(given["--json"]),
    holdFor: given["--for"] ?? null,
    evidence: given["--evidence"] ?? null,
    note: given["--note"] ?? null,
    redo: Boolean(given["--redo"]),
    fresh: Boolean(given["--fresh"]),
  };
}

export function run(argv, ctx) {
  const { step, id: typed, value, json, error, ...given } = parse(argv);
  if (error) return usageError("lane exec", error);
  const resolved = runId(ctx.spec, ctx.model, typed);
  if (resolved.error) return { exit: 2, out: say(`lane exec ${step} ${typed}`, resolved.error) };
  const { id } = resolved;
  const what = `lane exec ${step} ${id}`;
  const problem = idProblem(id);
  if (problem) return usageError("lane exec", problem);
  const root = realpathSync(ctx.root);
  const main = mainRoot(root);
  if (!main || realpathSync(main) !== root)
    return {
      exit: 2,
      out: say(what, `runs from the main checkout: pass --root ${main ?? "<the repository>"}`),
    };
  // The lane's kind: its ledger's (the lifecycle's for a ledger from before kinds), else the id's.
  let lane = null;
  try {
    lane = ledgers.read(root, id);
  } catch {} // the step itself refuses an unreadable ledger
  const kind = lane ? kindOf(lane, ctx.spec) : resolved.kind;
  try {
    const res = HANDLERS[step]({ ...ctx, root, kind, ...given }, id, value);
    return json ? res : { ...res, out: humanView(JSON.parse(res.out)) };
  } catch (e) {
    if (e instanceof Refusal || e instanceof WriteError)
      return { exit: 2, out: say(what, e.message) };
    throw e;
  }
}

// ---- git facts ------------------------------------------------------------------------------------
//
// The main-touched guard is content-exact. `start` records the content id (git's blob id) of every
// file that is dirty in main, and each lifecycle write a lane makes records `{ file, from, to }` in its
// ledger (`boardWrites`); each `board add` / `board set --apply` in main records the same in a shared log
// (`board-writes.mjs`). At a report, a main file may differ from the lane's start only when its content is
// reachable from its start content, or from the content a recorded merge committed, through recorded
// lifecycle writes or board writes made since the lane started. Any other edit (another row, free text, a
// non-board file, a file dirty at start that changed since) is the builder's, unless its path matches the
// workflow file's `guard.allow` and no running lane owns it. HEAD may move only by merges other ledgers
// record, each a run preHead → landed… → board commit that git's first-parent history confirms, and by
// commits on main whose every path `guard.allow` lets through and no running lane owns (A44).

// Agentry's own files: the run state. (The memory records a lane writes are `own-memory.mjs`'s.)
const OWN_DIRS = [".agentry/run/"];
const ABSENT = "-";
const MODE_SUFFIX = { 100755: ":x", 120000: ":l" };
const STAGED = /^[MADRC]/;
const stagedKey = (entry) => `${entry[0]}${entry.slice(3)}`; // index column + path
const headOf = (dir, ref = "HEAD") =>
  git(dir, ["rev-parse", "--verify", "--quiet", ref]).stdout.trim();

// Main's changed paths (Agentry's run files and new memory records left out) → their `git status` entry; a rename
// comes as its delete and its add (`porcelain`), so both paths are checked.
function dirtyPaths(root) {
  const parts = dirtyEntries(root);
  if (!parts) refuse(`git status failed in ${root}`);
  const out = new Map();
  for (const entry of parts) {
    const path = entry.slice(3);
    if (!OWN_DIRS.some((d) => path.startsWith(d)) && !STAGED.test(out.get(path) ?? ""))
      out.set(path, entry); // a staged entry stays when the path is also untracked (`rm --cached`)
  }
  return out;
}

// What is stored for each path as it is in main's working tree (`board-writes.mjs`): the ids recorded
// lifecycle and board writes carry.
function contentOf(root, paths) {
  try {
    return contentIds(root, paths);
  } catch (e) {
    return refuse(e.message);
  }
}

// The same, as `commit` holds it, ABSENT when the commit has no such file.
function blobsAt(root, commit, paths) {
  const out = Object.fromEntries(paths.map((p) => [p, ABSENT]));
  const res = git(root, ["--literal-pathspecs", "ls-tree", "-r", "-z", commit, "--", ...paths]);
  for (const line of res.stdout.split("\0").filter(Boolean)) {
    const tab = line.indexOf("\t");
    const path = line.slice(tab + 1);
    const [mode, , id] = line.slice(0, tab).split(" ");
    if (Object.hasOwn(out, path)) out[path] = id + (MODE_SUFFIX[mode] ?? "");
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
    modes: true, // `files` ids carry `:x` / `:l`; a ledger without this holds an executable as a bare id
  };
}

// The files a lifecycle event of item `id` of `name` writes (relative to the git root).
function boardFiles(spec, model, id, name) {
  if (!spec.lifecycle) return [];
  const kind = own(spec.kinds, name);
  const item = own(model.kinds, name)?.items.find((i) => i.id === id);
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

// The main files whose content no recorded lifecycle or board write explains, and whose path `excused`
// does not let through, as `git status` entries.
function strayFiles(root, ledger, head, all, boards, excused) {
  const was = ledger.mainAtStart;
  const started = was.files ?? {};
  const dirty = new Map([...dirtyPaths(root)].filter(([p]) => !excused(p)));
  const paths = [...new Set([...dirty.keys(), ...Object.keys(started)])].filter((p) => !excused(p));
  if (!paths.length) return [];
  const now = contentOf(root, paths);
  const atStart = blobsAt(root, was.head, paths);
  const atHead = head === was.head ? atStart : blobsAt(root, head, paths);
  // A ledger without `startedAt` predates the board-write log: no logged write is trusted for it.
  const logged = ledger.startedAt ? recordedSince(root, ledger.startedAt) : [];
  const moves = [
    ...all.flatMap((l) => l.boardWrites ?? []).filter((m) => boards.has(m.file)),
    ...logged,
  ];
  const changed = paths
    .filter((p) => {
      const start = Object.hasOwn(started, p) ? started[p] : atStart[p];
      if (now[p] === start) return false;
      // A ledger written before ids carried `:x` holds an executable file as its bare blob id.
      if (!was.modes && Object.hasOwn(started, p) && now[p] === `${start}:x`) return false;
      const from = atHead[p] === atStart[p] ? [start] : [start, atHead[p]];
      return !reachable(
        moves.filter((m) => m.file === p),
        from,
        now[p],
      );
    })
    .map((p) => dirty.get(p) ?? `${p} (back to HEAD)`);
  // An index-only change (`git rm --cached`) leaves the content as it was: any staged entry that was
  // not there at start is the builder's too.
  // The index column is compared, not the whole entry: a recorded write on a file staged at start turns
  // "M " into "MM" and the index is as it was.
  const stagedAtStart = new Set(was.porcelain.map(stagedKey));
  const staged = [...new Set(dirty.values())].filter(
    (e) => STAGED.test(e) && !stagedAtStart.has(stagedKey(e)),
  );
  return [...new Set([...changed, ...staged])];
}

// Are main's first-parent commits from `from` to `to`, end to end, merges other ledgers record or
// commits `blocked` lets through? A merge must be the run preHead → landed… → board commit its ledger
// names, in that order, on git's own first-parent line: a ledger is trusted only as far as git confirms
// it. `blocked(sha)` is null for a commit `guard.allow` lets through, else why not ("" for no reason to
// name). Returns `{ ok, allowed: [sha], why? }`: the allowed commits, and why the first other one is not.
function landedOnly(root, from, to, others, blocked = () => "") {
  const no = (why = "") => ({ ok: false, allowed: [], why });
  const res = git(root, ["rev-list", "--first-parent", "--reverse", `${from}..${to}`, "--"]);
  const chain = res.stdout.split("\n").filter(Boolean);
  if (res.status !== 0 || !chain.length) return no();
  if (headOf(root, `${chain[0]}^`) !== from) return no();
  const allowed = [];
  const runs = others
    .map((l) => l.merge)
    .filter((m) => typeof m?.preHead === "string" && Array.isArray(m.landed) && m.landed.length)
    .map((m) => ({
      preHead: m.preHead,
      shas: [...m.landed, ...(typeof m.boardCommit === "string" ? [m.boardCommit] : [])],
    }));
  let at = from;
  for (let i = 0; i < chain.length; ) {
    if (isMemoryCommit(root, chain[i])) {
      at = chain[i++]; // the owner committing Agentry's own memory records
      continue;
    }
    const run = runs.find((r) => r.preHead === at && r.shas.every((s, k) => chain[i + k] === s));
    if (run) {
      i += run.shas.length;
      at = chain[i - 1];
      continue;
    }
    const why = blocked(chain[i]);
    if (why !== null) return no(why);
    allowed.push(chain[i]);
    at = chain[i++];
  }
  return { ok: true, allowed };
}

// The lanes whose owned files no commit on main may touch (A44): every one still running.
const RUNNING = ["building", "fixing", "verifying", "held"];

// Why a commit on main is not one `guard.allow` lets through (A44), as `landedOnly` asks: every path it
// touches (against its first parent) must match a `guard.allow` glob and be no running lane's owned file.
// null when it is; "" when the process file allows nothing, or a running lane's owned files can't be read.
function allowedCommit(root, spec, all) {
  const allow = own(spec, "guard")?.allow ?? [];
  if (!allow.length) return () => "";
  let owners;
  return (sha) => {
    const res = git(root, ["diff", "--no-renames", "--name-only", "-z", `${sha}^1`, sha, "--"]);
    if (res.status !== 0) return "";
    try {
      owners ??= all
        .filter((l) => RUNNING.includes(l.state))
        .map((l) => ({
          id: l.id,
          owned: ownedOf(root, l).map((o) => (typeof o === "string" ? o : o.path)),
        }));
    } catch {
      return "";
    }
    for (const path of res.stdout.split("\0").filter(Boolean)) {
      if (!matchesAny(allow, path)) return `${path} is not in guard.allow`;
      const lane = owners.find((o) => o.owned.some((entry) => ownsPath(entry, path)));
      if (lane) return `${path} is owned by ${lane.id}`;
    }
    return null;
  };
}

// A glob test with the gate's own matcher, as merge does.
const matchesAny = (globs, path) => globMatch(globs, path);

// Does an entry of a contract's owned files (a path, a directory, a glob, a bare file name, a
// `path:lines`) cover `path`? Read wide, case ignored: a doubt keeps the guard on.
function ownsPath(entry, path) {
  const e = entry
    .toLowerCase()
    .replace(/:[\d\s,–-]+$/, "")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
  const p = path.toLowerCase();
  if (p === e || p.startsWith(`${e}/`) || matchesAny([e], p)) return true;
  return !e.includes("/") && posix.basename(p) === e;
}

// The main edits `guard.allow` lets through: a path one of its globs matches and no running lane owns.
// When a running lane's owned files cannot be read, nothing is let through.
function allowedEdit(root, spec, all) {
  const allow = own(spec, "guard")?.allow ?? [];
  if (!allow.length) return () => false;
  let owned;
  try {
    owned = all
      .filter((l) => l.state !== "merged" && l.state !== "closed")
      .flatMap((l) => ownedOf(root, l).map((o) => (typeof o === "string" ? o : o.path)));
  } catch {
    return () => false;
  }
  return (path) => matchesAny(allow, path) && !owned.some((entry) => ownsPath(entry, path));
}

// Whether the main checkout still matches the lane's start: `{ touched, allowed }`, `touched` why not
// (or null), `allowed` the commits on main `guard.allow` let through.
function mainGuard({ root, spec, model }, ledger, all) {
  const was = ledger.mainAtStart;
  const head = headOf(root);
  const others = all.filter((l) => l.id !== ledger.id);
  const reasons = [];
  let allowed = [];
  if (head !== was.head) {
    const moved = landedOnly(root, was.head, head, others, allowedCommit(root, spec, all));
    if (moved.ok) allowed = moved.allowed;
    else
      reasons.push(
        `HEAD moved ${short(was.head)} → ${short(head)}${moved.why ? ` (${moved.why})` : ""}`,
      );
  }
  const boards = new Set(all.flatMap((l) => boardFiles(spec, model, l.id, kindOf(l, spec))));
  const stray = strayFiles(root, ledger, head, all, boards, allowedEdit(root, spec, all));
  if (stray.length) reasons.push(`files changed: ${stray.slice(0, 10).join(", ")}`);
  return { touched: reasons.length ? reasons.join("; ") : null, allowed };
}

// Why the main checkout no longer matches the lane's start, or null.
const mainTouched = (ctx, ledger, all) => mainGuard(ctx, ledger, all).touched;

// Is `path` strictly inside the directory `dir`?
const inside = (dir, path) => {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

// The worktrees inside the lane's own worktree (a nested builder, #7): nothing else. A worktree made
// elsewhere while the lane ran (the conductor's own) is not the lane's.
function nestedTrees(root, ledger) {
  const seen = worktrees(root)
    .map((t) => t.path)
    .filter((p) => inside(ledger.worktree, p));
  return [...new Set([...(ledger.nested ?? []), ...seen])];
}

// The lanes that count against `lanes.maxWriters`: open ledgers that build or fix, and worktrees no
// ledger owns, except the ones the repo keeps on purpose (`worktrees.keep`) and the host's own agent
// worktrees (`.claude/worktrees/`), which no lane started.
function writers(root, spec) {
  const all = ledgers.list(root);
  const owned = new Set(all.map((l) => l.worktree));
  const agents = join(root, ".claude", "worktrees");
  return [
    ...all
      .filter((l) => l.state === "building" || l.state === "fixing")
      .map((l) => `${l.id} (${l.state}, ledger ${l.worktree})`),
    ...worktrees(root)
      .filter(
        (t) => t.path !== root && !owned.has(t.path) && !isKept(spec, t) && !inside(agents, t.path),
      )
      .map((t) => `${t.path} (${t.branch ?? "detached"}, no ledger)`),
  ];
}

// `start` and a `resume` that sends a builder are refused while `lanes.maxWriters` writers are open.
function refuseAtWriterCap(root, spec) {
  const config = readConfig(root);
  if (config.error) refuse(config.error);
  const open = writers(root, spec);
  if (open.length >= config.lanes.maxWriters)
    refuse(
      `${open.length} writer(s) open, lanes.maxWriters is ${config.lanes.maxWriters}; finish or merge one first:\n${open.map((w) => `  ${w}`).join("\n")}`,
    );
}

// ---- briefs ---------------------------------------------------------------------------------------

const contractFile = (root, id) => join(ledgers.runDir(root, id), "contract.md");

function gateLine(root, spec, ledger) {
  if (!gateOf(spec)) return "none: the workflow file has no gate, so run the repo's own checks";
  return `cd ${q(ledger.worktree)} && ${laneLine(root, "gate", ledger.id)}`;
}

// The tier `role` runs in the lane's worktree: on the files the branch changed since its base, and the
// item's flag.
const laneTier = (ctx, ledger, config, role) =>
  pickTier(config, role, {
    changed: changedSince(ledger.worktree, ledger.base, "HEAD") ?? [],
    flagged: isFlagged(ctx, ledger),
  });

// The gate part of a verify brief. A green record to read instead of re-running: the latest worktree gate
// run on this very tip and tree (a moved tip never matches), green on a clean tree, of the tier the verify
// (or build) role runs. A red after a green is the latest, so it is not read. Without one, under
// `gate.roles.verify: "none"` the gate is not the verifier's (the lane runs the build tier after the
// verdict); else the brief carries the full gate line. The slots every brief is given.
function recordedGate(ctx, ledger, tip) {
  const { root, spec } = ctx;
  const config = gateOf(spec);
  const tree = headOf(root, `${tip}^{tree}`);
  const latest = (ledger.gates ?? []).findLast(
    (g) => g.where === "worktree" && g.commit === tip && (g.tree === undefined || g.tree === tree),
  );
  const build = config ? laneTier(ctx, ledger, config, "build").tier : null;
  const tiers = config ? [laneTier(ctx, ledger, config, "verify").tier, build] : [];
  const record = latest && greenOn([latest], tip) && tiers.includes(latest.tier) ? latest : null;
  const notYours = !record && config?.roles.verify === "none";
  return {
    gateGreen: !!record,
    gateNotYours: notYours,
    gateRun: !record && !notYours,
    buildTier: build ?? "",
    gateSha: record ? short(record.commit) : "",
    gateLog: record?.log ?? "",
  };
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
  const owned = ownedOf(root, ledger);
  const builder = ledger.rounds.filter((r) => r.role === "build").at(-1);
  const tip = headOf(root, ledger.branch);
  const fresh = !dispatch.resend;
  // The notes the conductor picked: a notes-fix round carries them, and so does the recheck after it.
  const picked =
    dispatch.step === "recheck" && fresh && builder?.notes
      ? builder
      : dispatch.step === "fix" && dispatch.notes
        ? dispatch
        : null;
  const values = {
    id: ledger.id,
    round: n,
    contract: `${ledger.contract.file}:${ledger.contract.line}`,
    block: block.trimEnd(),
    related: !!ledger.contract.related?.length,
    notes: notesSection(ledger.contract.related),
    owned: bullets(owned.map((o) => `\`${o.path}\`${ownedMark(o).slice(o.path.length)}`)),
    decisions: bullets(
      citedDecisions({ root, spec, model, block, task: ledger.id, cite: ledger.cite }).map(
        (d) => `${d.id}: ${d.text}`,
      ),
    ),
    facts: factsLine(
      root,
      owned.map((o) => o.path),
      block,
    ),
    worktree: ledger.worktree,
    cd: `cd ${q(ledger.worktree)}`,
    branch: ledger.branch,
    base: short(ledger.base),
    mainRoot: root,
    logDir,
    reportPath: join(dir, `${name}.report.md`),
    gateLine: gateLine(root, spec, ledger),
    ...recordedGate({ root, spec, model }, ledger, tip),
    tip: short(tip),
    from: dispatch.from ?? "",
    reason: dispatch.reason ?? "",
    resend: !!dispatch.resend,
    recheck: dispatch.step === "recheck" && fresh,
    picked: !!picked,
    pickedNotes: picked ? noteLines(picked.from, picked.notes) : "",
    fail: dispatch.step === "fix" && !dispatch.guard && !dispatch.notes && fresh,
    guard: !!dispatch.guard && fresh,
    needed: dispatch.step === "needs-context" && fresh,
    builderReport: builder?.reportPath ?? "none",
    earlier: verdicts(ledger)
      .map((r) => r.reportPath)
      .join(", "),
    ...policySlots(spec, dispatch.step),
    ...stepSlots({
      steps: ledger.steps,
      stepRun: dispatch.stepRun,
      holds: ledger.holds,
      step: dispatch.step,
      fresh,
    }),
  };
  const file = join(dir, `${name}.md`);
  const text = renderBrief(dispatch.step, values);
  writeFileSync(file, dispatch.step === "fix" && picked ? withNotesToFix(text, picked) : text);
  return { brief: file, reportPath: values.reportPath, tip, at: now() };
}

const dispatchNext = (ctx, ledger, dispatch) =>
  dispatch ? addRound(ledger, dispatch, brief(ctx, ledger, dispatch)) : ledger;

// ---- output ---------------------------------------------------------------------------------------

// The steps of a contract, one line each: `1. <text> → owner OK`.
const stepLines = (steps) =>
  steps.map((s) => `${s.n}. ${s.text}${s.gate === "owner" ? " → owner OK" : ""}`).join("\n");
const stepCount = (ledger) => ledger.steps?.length ?? 0;

// What a held lane prints right after the header: the hold, and the step that answers it.
const heldLead = (root, ledger) =>
  ledger.state === "held" && ledger.hold
    ? {
        held: heldText(ledger.hold, stepCount(ledger)),
        run: laneLine(root, "resume", ledger.id, ' --note "<the OK>"'),
      }
    : {};

function view(ctx, ledger, { step, guards = [], nested = [], lead = {}, extra = {} }) {
  const { root, spec, model } = ctx;
  const round = ledger.rounds.at(-1);
  const out = {
    id: ledger.id,
    step,
    next: ledger.next,
    state: ledger.state,
    ...heldLead(root, ledger),
    ...lead,
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
      `Read your brief first: ${round.brief}. Work only in ${ledger.worktree}; prefix every shell command with \`cd ${q(ledger.worktree)} &&\`.`,
    ].join("\n");
    out.brief = round.brief;
    out.role = round.role;
    out.mode = round.mode === "resume" && round.agent ? "resume" : "fresh";
    if (out.mode === "resume") out.agent = round.agent;
    const builder = suggestBuilder(ownedOf(root, ledger).map((o) => o.path));
    out.dispatch = round.role === "verify" ? { agent: "verifier" } : builder;
    const picked = modelFor(spec, round.role, {
      flagged: isFlagged(ctx, ledger),
      ui: builder.agent === "designer",
    });
    if (picked) out.model = picked;
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

// Is the item flagged: when the lane started, or on the board now (a flag set since still counts).
const isFlagged = ({ spec, model }, ledger) =>
  Boolean(ledger.route?.flagged) || flaggedItem(spec, model, ledger.id, kindOf(ledger, spec));

// The owned files every brief names: parsed once at start and kept in the ledger (amended by `owns`).
// A ledger from before that is parsed from its contract file, against its worktree as `start` does.
const ownedOf = (root, ledger) =>
  ledger.owned ??
  withNew(
    ledger.worktree,
    ownedFiles(readFileSync(contractFile(root, ledger.id), "utf8"), ledger.worktree),
  );

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

// One lifecycle event on item `id` of the lane's kind (`ctx.kind`), and what it did to each file as
// `{ file, from, to }` content ids: the writes the main guard follows (`boardWrites` in the ledger).
function boardEvent(ctx, event, id, data) {
  const { root, spec, model, kind } = ctx;
  const before = contentOf(root, boardFiles(spec, model, id, kind));
  const board = applyEvent({ root, spec, model, event, id, kind, data });
  const files = [...new Set(board.writes.map((w) => w.file))];
  const after = contentOf(root, files);
  return { board, moves: files.map((file) => ({ file, from: before[file], to: after[file] })) };
}

// The owned files `owned` shares with a running lane (not merged or closed), as warning lines: `! owns
// overlap with R1c-4: plugin/commands/go.md`. A pair overlaps when one entry covers the other; the
// narrower of the two is named. A running lane whose owned files can't be read is skipped.
const OVERLAP_SHOWN = 5;
function ownsOverlap(root, owned) {
  const mine = owned.map((o) => o.path);
  const lines = [];
  for (const lane of ledgers.list(root)) {
    if (lane.state === "merged" || lane.state === "closed") continue;
    let theirs;
    try {
      theirs = ownedOf(root, lane).map((o) => (typeof o === "string" ? o : o.path));
    } catch {
      continue;
    }
    const shared = new Set();
    for (const a of mine)
      for (const b of theirs) {
        if (ownsPath(a, b)) shared.add(b);
        else if (ownsPath(b, a)) shared.add(a);
      }
    if (!shared.size) continue;
    const names = [...shared];
    const more = names.length - OVERLAP_SHOWN;
    lines.push(
      `! owns overlap with ${lane.id}: ${names.slice(0, OVERLAP_SHOWN).join(", ")}${more > 0 ? ` (+${more} more)` : ""}`,
    );
  }
  return lines.join("\n");
}

// A light contract (an `exec.kinds` kind's): an Owns line naming at least one path, and a bold Acceptance
// label with text after it on its line, both outside a code fence.
const ACCEPTANCE = /\*\*acceptance:?\*\*:?[ \t]*\S/i;
const FENCE = /^\s*(```|~~~)/;
function lightContract(block, root) {
  let fenced = false;
  const lines = block.split("\n").filter((line) => {
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced) return true;
    return false;
  });
  const prose = lines.join("\n");
  return ownedFiles(prose, root).length > 0 && lines.some((l) => ACCEPTANCE.test(l));
}

function start(ctx, id) {
  const { root, spec, model, cite, kind } = ctx;
  const unknown = unknownCites({ spec, model, cite });
  if (unknown.length) refuse(`--cite names no decision on the board: ${unknown.join(", ")}`);
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
  refuseAtWriterCap(root, spec);
  const found = findContract({ root, spec, id, kind });
  if (found.status !== "found") {
    const where = found.candidates.map((c) => `  ${c.file}:${c.line}`).join("\n");
    refuse(`contract ${id}: ${found.status}${where ? `\n${where}` : ""}`);
  }
  if (found.stepsProblem) refuse(`contract ${id}: ${found.stepsProblem}`);
  if (kind !== spec.lifecycle?.kind && lifecycleOf(spec, kind) && !lightContract(found.block, root))
    refuse(
      `contract ${id} is light and needs an Owns line naming files and an Acceptance line: ${found.file}:${found.line}`,
    );
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
    contract: {
      file: found.file,
      line: found.line,
      ...(found.related?.length ? { related: relatedNotes(root, found.related) } : {}),
    },
    origin: "exec",
    mainBranch,
    base,
    worktree: tree.path,
    branch: tree.branch,
    mainAtStart: mainSnapshot(root),
    worktreesAtStart: worktrees(root).map((t) => t.path),
    owned: withNew(tree.path, ownedFiles(found.block, tree.path)),
    ...(found.steps?.length && { steps: found.steps }),
    ...(cite.length && { cite }),
    route: { verify: verifyRoute(spec), flagged: flaggedItem(spec, model, id, kind) },
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
  const overlap = ownsOverlap(root, ledger.owned);
  ledger = dispatchNext(ctx, ledger, begin(ledger.steps).dispatch);
  ledgers.write(root, ledger);
  return view(ctx, ledger, {
    step: "start",
    extra: {
      owned: ledger.owned,
      amend: laneLine(root, "owns", id, " --set <paths> --apply"),
      ...(ledger.steps && { steps: stepLines(ledger.steps) }),
      route: routeText(ledger.route),
      board,
      ...(overlap && { warning: overlap }),
    },
  });
}

// The owned files the briefs name. `--set a,b` replaces them (shown until `--apply`); on apply the brief
// waiting to be answered is rewritten, so the agent reads the amended list.
function owns(ctx, id) {
  const { root, set, apply } = ctx;
  let ledger = mustLedger(root, id);
  const shown = (extra = {}) => ({
    exit: 0,
    out: JSON.stringify(
      { id, step: "owns", next: ledger.next, state: ledger.state, owned: ledger.owned, ...extra },
      null,
      2,
    ),
  });
  if (set === null) {
    ledger.owned = ownedOf(root, ledger);
    return shown({ amend: laneLine(root, "owns", id, " --set <paths> --apply") });
  }
  const paths = [...new Set(set.split(",").map((p) => p.trim()))];
  const bad = paths.find((p) => !p || /\s/.test(p));
  if (bad !== undefined) refuse(`--set takes comma-separated paths, no blanks: "${bad}"`);
  ledger = { ...ledger, owned: withNew(ledger.worktree, paths) };
  if (!apply) return shown({ applied: false, preview: PREVIEW });
  const round = ledger.rounds.at(-1);
  // A held lane has no brief waiting: the round after the resume reads the new list.
  const waiting = round && ledger.state !== "held" && expects(ledger);
  ledgers.write(root, ledger);
  if (waiting) {
    // The brief is rendered again from its template: a section the conductor appended to it (the fact a
    // needs-context round asks for) goes back at the end.
    const old = readFileSync(round.brief, "utf8");
    brief(ctx, { ...ledger, rounds: ledger.rounds.slice(0, -1) }, round);
    const kept = appendedAfter(old, readFileSync(round.brief, "utf8"));
    if (kept) appendFileSync(round.brief, kept);
  }
  return shown({ applied: true, ...(waiting && { rewrote: round.brief }) });
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
  const main = mainGuard(ctx, ledger, all);
  const guards = {
    mainTouched: main.touched,
    dirty,
    commits: count.status === 0 ? Number(count.stdout.trim()) : 0,
    subjects: rulesOf(ctx.spec)
      ? brokenIn(root, ctx.spec, commitsBetween(root, ledger.base, ledger.branch) ?? [])
      : [],
  };
  const flagged = isFlagged(ctx, ledger);
  const res = stepWith(ledger, {
    type: "report",
    status: builderStatus(text),
    report: round.reportPath,
    agent,
    summary: summaryOf(text),
    guards,
    skipVerify: skipsVerifier(ledger.route, flagged),
    tip: headOf(root, ledger.branch),
    gate: gateOf(ctx.spec) !== null,
    at: now(),
  });
  let next = res.ledger;
  if (ledger.route) next.route = { ...ledger.route, flagged };
  next.usedMemories = [...new Set([...(next.usedMemories ?? []), ...usedMemories(text)])];
  next.nested = nestedTrees(root, next);
  const board = writeBuilt(ctx, next, res);
  next = dispatchNext(ctx, next, res.dispatch);
  ledgers.write(root, next);
  const allowed = main.allowed.length
    ? [
        `main moved by allowed commits: ${main.allowed.length} (${main.allowed.map(short).join(", ")})`,
      ]
    : [];
  return view(ctx, next, {
    step: "report",
    guards: [...(next.rounds.at(res.dispatch ? -2 : -1).guards ?? []), ...allowed],
    nested: next.nested,
    extra: { ...(res.reason && { why: res.reason }), ...(board && { board }) },
  });
}

// Built is written once, when the item goes to a verifier, or straight to the gate when none reads it:
// never at a hold, a resume that carries on building, or a run's end before the last step. Returns
// what the lifecycle wrote, and records its moves in `ledger`.
function writeBuilt(ctx, ledger, res) {
  const next =
    ["verify", "recheck"].includes(res.dispatch?.step) || ["gate", "close"].includes(res.next);
  if (!next) return null;
  const built = boardEvent(ctx, "built", ledger.id);
  ledger.boardWrites = [...(ledger.boardWrites ?? []), ...built.moves];
  return built.board;
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
  next.nested = nestedTrees(root, next);
  const judged = next.rounds.at(-1);
  const written =
    judged.verdict && !judged.void
      ? boardEvent(ctx, "verdict", id, { verdict: judged.verdict })
      : null;
  const board = written?.board ?? null;
  next.boardWrites = [...(next.boardWrites ?? []), ...(written?.moves ?? [])];
  next = dispatchNext(ctx, next, res.dispatch);
  ledgers.write(root, next);
  return view(ctx, next, {
    step: "verdict",
    nested: next.nested,
    extra: {
      verdict: judged.void ? "void" : (judged.verdict ?? null),
      ...(gateTally(next.gates, judged.tip).text && {
        gates: gateTally(next.gates, judged.tip).text,
      }),
      ...(res.reason && { why: res.reason }),
      ...(board && { board }),
    },
  });
}

// A verifier's brief that is waiting is written again from its template, so a gate that went green on its
// tip since (#43) is read, not re-run, and one that went red after it is run again. What the conductor
// appended after the last section is put back.
function refreshBrief(ctx, ledger) {
  const round = ledger.rounds.at(-1);
  const old = readFileSync(round.brief, "utf8");
  brief(ctx, { ...ledger, rounds: ledger.rounds.slice(0, -1) }, round);
  const kept = appendedAfter(old, readFileSync(round.brief, "utf8"));
  if (kept) appendFileSync(round.brief, kept);
  return round.brief;
}

// Gates queue behind the lock (`gate.concurrency` slots, in the main checkout's run directory); a flaky
// re-run holds every slot, so it runs alone.
function gate(ctx, id) {
  const { root, spec } = ctx;
  let ledger = mustLedger(root, id);
  if (ledger.state === "stopped" || ledger.next === "merge")
    refuse(`the lane is ${ledger.state} (next ${ledger.next}): no gate to run`);
  const config = gateOf(spec);
  if (!config) refuse("the workflow file has no gate: add one (/agentry:init) to run it here");
  // While a verifier is out the gate runs the verify role's tier; else the build role's.
  const role = expects(ledger) === "verdict" ? "verify" : "build";
  const tier = laneTier(ctx, ledger, config, role);
  if (!tier.tier)
    refuse(
      `${tier.reason}: the verifier reads the recorded gate; the lane runs the build tier after the verdict`,
    );
  const { command } = tier;
  const lockDir = gateLockDir(root);
  let runs = ledger.gates?.length ?? 0;
  let startedAt = 0;
  const once = (exclusive) => {
    // The log exists before the wait, so a queued gate says so there (a gate that is waiting is not hung).
    // A number no log holds yet: a killed gate is not in the ledger, and its log must not be written into.
    let logFile;
    do logFile = join(ledgers.runDir(root, id), "logs", `gate-${++runs}.log`);
    while (existsSync(logFile));
    const held = holdGate(lockDir, {
      slots: config.concurrency,
      exclusive,
      who: `lane ${id}`,
      log: logFile,
    });
    if (held.busy)
      refuse(
        `another gate holds the gate lock (${held.busy.who || "unknown"}, pid ${held.busy.pid ?? "?"}) at ${held.busy.file} and did not end within an hour: run this step again when it has, or delete that file if nothing holds it`,
      );
    try {
      startedAt = Date.now();
      const res = runGate(ledger.worktree, command, { tier: tier.tier, logFile });
      // A refused run wrote nothing but the wait: the next run starts that number's log afresh.
      if (res.refused) {
        rmSync(logFile, { force: true });
        runs--;
      }
      return res;
    } finally {
      held.release();
    }
  };
  const first = once(false);
  if (first.refused)
    refuse(
      `the worktree is not clean, so the gate did not run: ${first.files.slice(0, 10).join(", ")}`,
    );
  // A red that failed only in listed flaky tests, on a clean tree, is re-run once, alone.
  const flaky =
    first.exit !== 0 && first.cleanAfter
      ? flakyReds(first.log, config.flaky, {
          logs: config.flakyLogs,
          cwd: ledger.worktree,
          since: startedAt,
        })
      : null;
  const again = flaky ? once(true) : null;
  const reran = again && !again.refused;
  const ran = reran ? again : first;
  const records = [
    {
      where: "worktree",
      role,
      ...first,
      command,
      ...(reran && { flakyRed: flaky }),
      why: tier.reason,
      at: now(),
    },
    ...(reran
      ? [{ where: "worktree", role, ...again, command, rerun: true, why: tier.reason, at: now() }]
      : []),
  ];
  let res = { ledger };
  for (const record of records) res = stepWith(res.ledger, { type: "gate", record });
  ledger = res.ledger;
  ledgers.write(root, ledger);
  // Any run, green or red, changes what the waiting verifier's brief says about the gate.
  const refreshed = expects(ledger) === "verdict" ? refreshBrief(ctx, ledger) : null;
  const shown = view(ctx, ledger, {
    step: "gate",
    extra: {
      ...(refreshed && { briefUpdated: refreshed }),
      gate: {
        exit: ran.exit,
        role,
        tier: ran.tier,
        why: tier.reason,
        commit: short(ran.commit),
        seconds: ran.seconds,
        log: ran.log,
        ...(reran && { flaky, runs: records.length }),
      },
      gates: gateTally(ledger.gates, ran.commit).text,
      ...(res.reason && { why: res.reason }),
    },
  });
  return { ...shown, exit: ran.exit === 0 ? shown.exit : 1 };
}

// The label and text of each `N<number>` note in a verifier's report: a line that opens with its label.
function notesOf(text) {
  const notes = new Map();
  for (const line of text.split("\n")) {
    const m = /^[\s>#*`_-]*(N\d+)\b[\s.:)\]*`_-]*(.*)$/.exec(line);
    if (m && !notes.has(m[1])) notes.set(m[1], m[2].trim());
  }
  return notes;
}

// `- N1: text` for each label, read from the verifier report at `path` (an unreadable report gives bare labels).
function noteLines(path, labels) {
  let found = new Map();
  try {
    found = notesOf(readFileSync(path, "utf8"));
  } catch {}
  return labels.map((n) => `- ${n}: ${found.get(n) ?? ""}`.trimEnd()).join("\n");
}

// A notes-fix brief: the notes section goes in before the first of the brief's own sections.
function withNotesToFix(text, { from, notes }) {
  const section = [
    "## Notes to fix",
    "",
    `The verifier passed this with notes (${from}). Fix exactly these, each with a committed test where it is behavior, and leave the other notes alone:`,
    "",
    noteLines(from, notes),
    "",
  ].join("\n");
  const at = text.indexOf("\n## ");
  return at === -1
    ? `${text}\n${section}`
    : `${text.slice(0, at + 1)}${section}\n${text.slice(at + 1)}`;
}

// A verified lane (PASS WITH NOTES) goes back to its builder for the notes the conductor names; the rounds
// after it are the usual recheck. The board is not written: the next verdict is.
function fix(ctx, id, given) {
  const { root } = ctx;
  const ledger = mustLedger(root, id);
  const labels = [...new Set(given.split(",").map((n) => n.trim().toUpperCase()))];
  if (!labels.every((n) => /^N\d+$/.test(n)))
    refuse(`--notes takes the verifier's note labels, like N1,N3 (got ${given})`);
  const { used, max } = notesBudget(ledger);
  if (used >= max)
    refuse(
      `${used} of ${max} notes rounds are used (next is ${ledger.next}) → ${laneLine(root, ledger.next === "close" ? "close" : "gate", id)}, or send what is left to the owner`,
    );
  const res = stepWith(ledger, { type: "notes", notes: labels });
  const verifier = verdicts(ledger).at(-1);
  const report = verifier ? readReport(verifier.reportPath, "verifier") : "";
  const found = notesOf(report);
  const missing = labels.filter((n) => !found.has(n));
  if (missing.length)
    refuse(
      `${missing.join(", ")} not in the verifier's report ${verifier?.reportPath ?? "(none)"} (it has ${[...found.keys()].join(", ") || "no N<number> notes"})`,
    );
  const next = dispatchNext(ctx, res.ledger, res.dispatch);
  next.nested = nestedTrees(root, next);
  ledgers.write(root, next);
  return view(ctx, next, {
    step: "fix",
    nested: next.nested,
    extra: { notes: labels, ...(res.reason && { why: res.reason }) },
  });
}

// Is there a saved reply at `path`?
const saved = (path) => {
  try {
    return readFileSync(path, "utf8").trim() !== "";
  } catch {
    return false;
  }
};

// A builder's round waits: for the owner, who reviews what its saved reply points at (`--evidence`, by
// default that reply), or for later, a parked lane whose builder was stopped mid-round (no reply needed,
// the worktree kept as it is). The ledger alone is written: no board cell, nothing on main.
function hold(ctx, id, agent) {
  const { root, holdFor, evidence: given, note } = ctx;
  if (!["owner", "later"].includes(holdFor)) refuse("--for takes owner or later");
  const ledger = mustLedger(root, id);
  const held = ledger.state === "held";
  if (!held && expects(ledger) !== "report")
    refuse(`hold is for a builder's round: the lane is ${ledger.state} (next ${ledger.next})`);
  const round = ledger.rounds.at(-1);
  if (!held && holdFor === "owner" && !saved(round.reportPath))
    refuse(`the builder is still out: save its reply to ${round.reportPath} first, then hold`);
  const evidence = given === null ? null : resolve(root, given);
  if (evidence !== null && !existsSync(evidence)) refuse(`no file at ${given}`);
  if (!held) {
    const touched = mainTouched(ctx, ledger, ledgers.list(root));
    if (touched)
      refuse(
        `main touched: ${touched}: run ${laneLine(root, "report", id)} (the report stops the lane)`,
      );
  }
  const res = stepWith(ledger, {
    type: "hold",
    for: holdFor,
    evidence: evidence ?? (holdFor === "owner" ? round.reportPath : null),
    at: now(),
    ...(note && { why: note }),
    ...(agent && { agent }),
  });
  ledgers.write(root, res.ledger);
  return view(ctx, res.ledger, {
    step: "hold",
    extra: { ...(res.reason && { why: res.reason }) },
  });
}

// The owner's answer to a hold: recorded with its time, then the held round's builder carries on (the
// next run, the same run with --redo, or the same round after a hold during it), or after the last step
// the verifier (or the gate) is next and built is written. Main must be as the lane left it.
function resume(ctx, id) {
  const { root, spec, note, redo, fresh } = ctx;
  const ledger = mustLedger(root, id);
  if (ledger.state !== "held")
    refuse(`the lane is not held (state ${ledger.state}, next ${ledger.next})`);
  if (!note) refuse(`resume needs --note "<the owner's words>"`);
  if (redo && ledger.hold?.when !== "after")
    refuse(
      "--redo goes back over a finished run; this hold is during one, and resume carries on in it",
    );
  const touched = mainTouched(ctx, ledger, ledgers.list(root));
  if (touched) refuse(`main changed while ${id} was held: ${touched}: undo that, then resume`);
  const flagged = isFlagged(ctx, ledger);
  const res = stepWith(ledger, {
    type: "resume",
    note,
    redo,
    at: now(),
    skipVerify: skipsVerifier(ledger.route, flagged),
    tip: headOf(root, ledger.branch),
    gate: gateOf(spec) !== null,
  });
  if (res.dispatch?.role === "build") refuseAtWriterCap(root, spec);
  let next = res.ledger;
  if (ledger.route) next.route = { ...ledger.route, flagged };
  next.nested = nestedTrees(root, next);
  const board = writeBuilt(ctx, next, res);
  let dispatch = res.dispatch;
  if (dispatch && fresh) {
    const { agent, ...rest } = dispatch;
    dispatch = { ...rest, mode: "fresh" };
  }
  next = dispatchNext(ctx, next, dispatch);
  ledgers.write(root, next);
  const answer = next.holds.at(-1);
  return view(ctx, next, {
    step: "resume",
    nested: next.nested,
    lead: { [answerLabel(answer)]: answerText(answer, stepCount(next)) },
    extra: { ...(res.reason && { why: res.reason }), ...(board && { board }) },
  });
}

// The `episode_write` arguments for this lane, from the ledger alone.
const ownerHolds = (ledger) => (ledger.holds ?? []).filter((h) => h.for === "owner").length;
function episodeOf(ledger) {
  const judged = verdicts(ledger);
  const guardTrips = ledger.rounds.flatMap((r) => r.guards ?? []);
  const lastGate = ledger.gates?.at(-1);
  const what = ledger.rounds.findLast(
    (r) => r.role === "build" && r.step !== "fix" && r.summary,
  )?.summary;
  const outcome = [
    ledger.state === "stopped"
      ? `stopped: ${ledger.stopReason ?? "unknown"}`
      : ledger.origin === "adopted"
        ? "adopted: not built or verified by a lane"
        : judged.length === 0
          ? "gated: no verifier read it (exec.verify)"
          : `verified (${judged.at(-1)?.verdict})`,
    `rounds: ${ledger.rounds.map((r) => `${r.step}${r.resend ? " (resent)" : ""}`).join(", ")}`,
    `verdicts: ${judged.map((r) => r.verdict).join(", ") || "none"}`,
    `void verdicts: ${ledger.rounds.filter((r) => r.void).length}`,
    `guard trips: ${guardTrips.length ? guardTrips.join(" | ") : "none"}`,
    `worktree gate: ${lastGate ? `${lastGate.exit === 0 ? "green" : "red"} ${lastGate.tier} on ${short(lastGate.commit)}` : "none"}`,
    `nested worktrees: ${ledger.nested?.length ?? 0}`,
    `verify route: ${routeText(ledger.route)}`,
    ...(ownerHolds(ledger) ? [`owner holds: ${ownerHolds(ledger)}`] : []),
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
    const existing = ledger.episode.writtenId;
    if (existing && existing !== episodeId)
      refuse(`the episode is already stamped as ${existing}; not replacing it with ${episodeId}`);
    ledger = { ...ledger, episode: { ...ledger.episode, writtenId: episodeId } };
    ledgers.write(root, ledger);
    // The id is stamped as given; whether the memory store holds it is said, so a typo shows.
    const stored = episodeStored(root, episodeId);
    const warning = `no episode ${episodeId} in the memory store: check the id episode_write returned`;
    const shown = { id, step: "close", episode: ledger.episode, stored };
    return {
      exit: 0,
      out: JSON.stringify(stored ? shown : { ...shown, warning }, null, 2),
    };
  }
  if (ledger.episode?.writtenId)
    return {
      exit: 0,
      out: JSON.stringify(
        {
          id,
          step: "close",
          episode: ledger.episode,
          already: `the episode is written (${ledger.episode.writtenId}): write nothing more`,
        },
        null,
        2,
      ),
    };
  const closable =
    ledger.next === "close" ||
    ledger.state === "stopped" ||
    ledger.state === "merged" ||
    ledger.episode;
  if (!closable) refuse(`the lane is not done (state ${ledger.state}, next ${ledger.next})`);
  const payload = episodeOf(ledger);
  ledger = {
    ...ledger,
    episode: { ...ledger.episode, payload },
    ...(ledger.state === "verified" && { next: "merge" }),
  };
  ledgers.write(root, ledger);
  const shown = view(ctx, ledger, {
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
  const idle = idleOf(ledger.worktree, ledger, Date.now());
  return view(ctx, ledger, {
    step: "show",
    nested: nestedTrees(root, ledger),
    lead: idle ? { idle: { ...idle, park: laneLine(root, "hold", id, " --for later") } } : {},
    extra: {
      owned: ownedOf(root, ledger),
      ...(ledger.steps && { steps: stepLines(ledger.steps) }),
      ...(ledger.holds?.length && {
        holds: ledger.holds.map((h) => answerLine(h, stepCount(ledger))).join("\n"),
      }),
      route: routeText(ledger.route),
      rounds: ledger.rounds.map((r) => ({
        n: r.n,
        step: r.step,
        mode: r.mode,
        ...(r.resend && { resend: true }),
        ...(r.agent && { agent: r.agent }),
        ...(r.status && { status: r.status }),
        ...(r.verdict && { verdict: r.verdict }),
        ...(r.void && { void: true }),
        ...(r.held && { held: true }),
        ...(r.stepRun && { stepRun: r.stepRun }),
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

const HANDLERS = { start, report, verdict, gate, fix, close, show, owns, hold, resume };
