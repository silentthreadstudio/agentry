// run — the `agentry run` and `agentry lock` groups: one portable time limit, and the workflow file's
// named locks (`locks`, `lane/named-lock.mjs`).
//
//   agentry run --limit <dur> [--lock <name> [--wait <dur>]] -- <cmd> [args…]
//     runs argv (no shell) in its own process group (supervise.mjs) with stdio inherited and exits with its
//     code; at the limit the group gets SIGTERM, then SIGKILL 5 s later, and the exit is 124. `--lock` waits
//     for a slot first (for up to `--wait`, default 10m: then exit 75) and holds it until the command is gone
//     (and, if `agentry run` dies, until its process group is). A command that is a `gate.tiers` argv takes
//     the gate slot the same way (`--wait` then bounds that wait); with `--lock` too it takes the lock
//     without waiting once it holds the gate slot, and when the lock is busy lets the gate slot go and
//     waits for the lock first. Inside your own `lock take` of that lock, it takes no slot of its own, and
//     its run extends the take until the command is gone.
//   agentry lock take <name> [--for <lane>] [--ttl <dur>] [--wait <dur>] · lock drop <name> [--for <lane>]
//   [--orphan] · lock show
//     a lock held across tool calls, for a session that drives a shared editor through MCP. A take is
//     the session's (the host's `CLAUDE_PID`, when it gives one) and ends at its ttl (default 30m) or
//     when that process is gone.
//
// The locks live in the main checkout, so every worktree shares them. Exit 0 = ok, 1 = not held, 2 =
// usage or a lock the workflow file does not declare, 75 = the lock stayed busy for the whole wait. Node built-ins only.
import { readFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { clock, gateLockDir, holdGate, running } from "../lane/gate-lock.mjs";
import {
  POLL_MS,
  dropLock,
  dropOrphans,
  endRide,
  extendTake,
  heldLocks,
  locksOf,
  ownTake,
  releaseLock,
  setGroup,
  tryLock,
} from "../lane/named-lock.mjs";
import { mainRoot, worktreesDir } from "../lane/worktree.mjs";
import { gitRootOf } from "../process/contract.mjs";
import { workflowPathOf } from "../process/read.mjs";
import { gateOf, validateWorkflow } from "../process/spec/workflow.mjs";
import { renderHelp, say } from "./help.mjs";
import { GRACE_KILL_MS, supervise } from "./supervise.mjs";

/** The exit when a lock stayed busy for the whole wait (EX_TEMPFAIL). */
export const BUSY_EXIT = 75;
const TAKE_TTL = "30m";
const WAIT = "10m";
const UNITS = { s: 1000, m: 60_000, h: 3_600_000 };
const MAX_TIMER_MS = 2 ** 31 - 1;

const RUN_HELP = {
  usage: "run --limit <dur> [--lock <name> [--wait <dur>]] -- <cmd> [args…]",
  purpose:
    "Run a command (no shell) in its own process group and stop the whole group at the limit: SIGTERM, then SIGKILL 5 s later.",
  args: { "<cmd> [args…]": "the command, after --" },
  flags: {
    "--limit <dur>": "the time limit: <n>s, <n>m or <n>h (n above 0)",
    "--lock <name>":
      "wait for a slot of a lock the workflow file's locks declares, and hold it while the command runs",
    "--wait <dur>":
      "how long --lock (or, for a gate argv, the gate slot) waits for a slot before it gives up (default 10m)",
    "--root <dir>": "the git root (default: the main checkout of the current directory)",
    "--process <file>": "the process file; the workflow file is its sibling workflow.json",
  },
  exits: {
    "<code>": "the command's own exit code (128 + the signal when a signal ended it)",
    124: "the command hit the limit and was stopped",
    127: "the command could not be started",
    2: "usage, or a lock the workflow file does not declare",
    75: "the lock (or the gate slot) stayed busy for the whole --wait; the command never ran",
  },
  example: "agentry run --limit 10m --lock editor -- godot --headless --path . -s tests/run.gd",
};

const LOCK_HELP = {
  usage: [
    "lock take <name> [--for <lane>] [--ttl <dur>] [--wait <dur>]",
    "lock drop <name> [--for <lane>] [--orphan]",
    "lock show",
  ],
  purpose:
    "Hold a named lock across tool calls (a shared editor driven through MCP): take it before, drop it after.",
  args: { "<name>": "a lock the workflow file's locks declares" },
  flags: {
    "--for <lane>": "who holds it (default: the lane whose worktree this is)",
    "--orphan":
      "drop: free a slot held only by a leftover process group (its run died), after printing the group; refused while that run lives",
    "--ttl <dur>": "when a take ends on its own: <n>s, <n>m or <n>h (default 30m)",
    "--wait <dur>": "how long take waits for a slot before it gives up (default 10m)",
    "--root <dir>": "the git root (default: the main checkout of the current directory)",
    "--process <file>": "the process file; the workflow file is its sibling workflow.json",
  },
  exits: {
    0: "taken, dropped or shown",
    1: "drop: not held by you (--orphan: no leftover group to free, or its run still lives)",
    2: "usage, or an undeclared lock",
    75: "take: the lock stayed busy for the whole --wait",
  },
  example: "agentry lock take editor --for T-4",
};

/** `<n>s|m|h` in milliseconds, or null when it is not one (or is 0, or too long for a timer). */
export function durationMs(text) {
  const m = /^(\d+)([smh])$/.exec(text ?? "");
  const ms = m ? Number(m[1]) * UNITS[m[2]] : 0;
  return ms > 0 && ms <= MAX_TIMER_MS ? ms : null;
}

const fail = (what, why, next) => ({ exit: 2, err: say(what, why, next) });
const refuse = (what, why) => {
  process.stderr.write(`${say(what, why, `${what} --help`)}\n`);
  return 2;
};

// The options before `--` (each takes a value), or why one is refused.
function optionsOf(argv, what, takes) {
  const got = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (!takes.includes(name)) return fail(what, `unknown option "${name}"`, `${what} --help`);
    const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === "" || (eq < 0 && value.startsWith("--")))
      return fail(what, `${name} needs a value`, `${what} --help`);
    got[name] = value;
  }
  return { got, rest };
}

// The main checkout the locks live in, and the lane whose worktree the current directory is in (or null).
function placeOf(rootArg) {
  const dir = resolve(rootArg ?? process.cwd());
  const root = mainRoot(dir) ?? gitRootOf(dir) ?? dir;
  const inside = relative(worktreesDir(root), process.cwd());
  const lane =
    inside && !inside.startsWith("..") && !inside.startsWith(sep) ? inside.split(sep)[0] : null;
  return { root, lane };
}

const workflowFile = (root, processArg) =>
  workflowPathOf(resolve(processArg ?? join(root, ".agentry", "process.json")));

// The workflow file's locks, or why it cannot be used.
function declaredLocks(root, processArg, what) {
  const file = workflowFile(root, processArg);
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { locks: {}, file };
    return fail(
      what,
      `cannot read ${file} (${error.code ?? error.message})`,
      "agentry board check",
    );
  }
  const problems = [];
  validateWorkflow(value, (at, message) => problems.push(`${at} ${message}`));
  if (problems.length) return fail(what, `${file}: ${problems.join("; ")}`, "agentry board check");
  return { locks: locksOf(value), file };
}

// The refusal line of a lock that stayed busy for the whole wait.
const busyLine = (what, name, { who, since }) =>
  say(what, `lock ${name} busy (held by ${who} since ${since})`, "agentry lock show");

// Lock `name` as the workflow file declares it: `{ slots }`, or the refusal.
function lockNamed(name, { locks, file }, what) {
  if (Object.hasOwn(locks, name)) return { slots: locks[name] };
  const names = Object.keys(locks);
  const has = names.length ? `it declares ${names.join(", ")}` : "it declares no locks";
  return fail(what, `no lock "${name}" in the locks of ${file} (${has})`, "agentry lock show");
}

// The gate tier whose argv is exactly `cmd`, as `{ tier, slots }`, or null: a workflow file that is missing
// or broken has no gate here (a plain run never fails on it).
function gateTierOf(root, processArg, cmd) {
  try {
    const gate = gateOf(JSON.parse(readFileSync(workflowFile(root, processArg), "utf8")));
    const tier = gate?.tiers.find(
      (t) => t.command.length === cmd.length && t.command.every((word, i) => word === cmd[i]),
    );
    return tier ? { tier: tier.name, slots: gate.concurrency } : null;
  } catch {
    return null;
  }
}

// Who a `lock take` is for when it names no `--for`: the lane whose worktree this is.
const takerOf = (forArg, lane) => forArg ?? lane ?? "a session";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Wait up to `waitMs` for a slot, printing the wait once and the arrival after it: the `tryLock` result,
// `{ busy }` when the wait ran out.
async function acquire(root, name, waitMs, opts) {
  const deadline = Date.now() + waitMs;
  let waited = false;
  for (;;) {
    const got = tryLock(root, name, opts);
    if (!got.busy) {
      if (waited) process.stderr.write(`lock ${name} acquired\n`);
      return got;
    }
    if (Date.now() >= deadline) return got;
    if (!waited) {
      waited = true;
      process.stderr.write(
        `waiting for lock ${name} (held by ${got.busy.who} since ${got.busy.since})\n`,
      );
    }
    await sleep(POLL_MS);
  }
}

/** `agentry run …` (argv after the group): the exit code. */
export async function runCli(argv) {
  const dash = argv.indexOf("--");
  const before = dash < 0 ? argv : argv.slice(0, dash);
  const cmd = dash < 0 ? [] : argv.slice(dash + 1);
  if (before.includes("--help") || before.includes("-h")) {
    process.stdout.write(`${renderHelp("agentry", "run", RUN_HELP)}\n`);
    return 0;
  }
  const parsed = optionsOf(before, "agentry run", [
    "--limit",
    "--lock",
    "--wait",
    "--root",
    "--process",
  ]);
  const checked = parsed.err ? parsed : runArgs(parsed, cmd);
  if (checked.err) {
    process.stderr.write(`${checked.err}\n`);
    return checked.exit;
  }
  const { limitMs, limitText, lockName, waitMs } = checked;
  const { root, lane } = placeOf(parsed.got["--root"]);
  const releases = [];
  const releaseAll = () => {
    for (const release of releases.splice(0)) release();
  };
  // Released at the end of the command (a slot whose command left a process group running stays held), or
  // when this process exits early (a signal that was not forwarded).
  const hold = (release) => {
    releases.push(release);
    process.once("exit", releaseAll);
  };
  let lock = null;
  if (lockName) {
    const declared = declaredLocks(root, parsed.got["--process"], "agentry run");
    lock = declared.err ? declared : lockNamed(lockName, declared, "agentry run");
    if (lock.err) {
      process.stderr.write(`${lock.err}\n`);
      return lock.exit;
    }
  }
  const gate = gateTierOf(root, parsed.got["--process"], cmd);
  if (parsed.got["--wait"] !== undefined && !lockName && !gate)
    return refuse(
      "agentry run",
      "--wait is for --lock (or a gate argv): there is nothing to wait for",
    );
  const starts = [];
  const deadline = Date.now() + waitMs;
  const mine = lock
    ? ownTake(root, lockName, { slots: lock.slots, pid: sessionPid(), who: takerOf(null, lane) })
    : null;
  const who = `${lane ? `${lane}: ` : ""}${basename(cmd[0])}`;
  // The gate slot comes first, so a named lock is never held while this run queues for the gate, and the
  // gate slot is never held while it waits for a named lock: a busy lock sends the run back to the queue.
  let slot = null;
  let said = false;
  for (;;) {
    if (gate) {
      if (!said)
        process.stderr.write(`run: this is the gate (${gate.tier}): taking the gate slot\n`);
      said = true;
      const held = holdGate(gateLockDir(root), {
        slots: gate.slots,
        who: lane ? `lane ${lane}` : "agentry run",
        waitSec: Math.max(0, deadline - Date.now()) / 1000,
        onNote: (line) => process.stderr.write(`${line}\n`),
      });
      if (held.busy) {
        process.stderr.write(
          `${say("run", `the gate slot stayed busy (held by ${held.busy.who || "unknown"}, pid ${held.busy.pid ?? "?"})`)}\n`,
        );
        return BUSY_EXIT;
      }
      hold(held.release);
      starts.push(held.group);
    }
    if (!lock || mine !== null) break;
    const opts = { slots: lock.slots, who };
    const got = gate ? tryLock(root, lockName, opts) : await acquire(root, lockName, waitMs, opts);
    if (!got.busy) {
      slot = got.slot;
      break;
    }
    let busy = got.busy;
    if (gate && Date.now() < deadline) {
      releaseAll();
      starts.length = 0;
      process.stderr.write(`lock ${lockName} busy: gate slot released while waiting for it\n`);
      const free = await acquire(root, lockName, deadline - Date.now(), opts);
      if (!free.busy) {
        releaseLock(root, lockName, free.slot);
        continue;
      }
      busy = free.busy;
    }
    releaseAll();
    process.stderr.write(`${busyLine("run", lockName, busy)}\n`);
    return BUSY_EXIT;
  }
  if (mine !== null) {
    process.stderr.write(`lock ${lockName}: inside your own take\n`);
    extendTake(root, lockName, mine, Date.now() + limitMs + GRACE_KILL_MS);
    hold(() => endRide(root, lockName, mine));
  } else if (slot !== null) {
    hold(() => releaseLock(root, lockName, slot));
    starts.push((pgid) => setGroup(root, lockName, slot, pgid));
  }
  try {
    return await supervise(cmd, limitMs, limitText, {
      onStart: (pgid) => {
        for (const start of starts) start(pgid);
      },
    });
  } finally {
    releaseAll();
  }
}

// The checked `run` arguments, or the refusal.
function runArgs({ got, rest }, cmd) {
  const what = "agentry run";
  if (rest.length)
    return fail(what, `"${rest[0]}" before --: put the command after --`, `${what} --help`);
  if (!cmd.length) return fail(what, "no command: put it after --", `${what} --help`);
  const limitText = got["--limit"];
  if (limitText === undefined) return fail(what, "--limit is required", `${what} --help`);
  const limitMs = durationMs(limitText);
  if (limitMs === null)
    return fail(
      what,
      `--limit "${limitText}" is not a time limit: <n>s, <n>m or <n>h, n above 0`,
      `${what} --help`,
    );
  const lockName = got["--lock"] ?? null;
  const waitMs = waitOf(got, what);
  if (waitMs.err) return waitMs;
  return { limitMs, limitText, lockName, waitMs };
}

// `--wait` in milliseconds (default 10m), or the refusal.
function waitOf(got, what) {
  const text = got["--wait"] ?? WAIT;
  const ms = durationMs(text);
  if (ms !== null) return ms;
  return fail(
    what,
    `--wait "${text}" is not a time: <n>s, <n>m or <n>h, n above 0`,
    `${what} --help`,
  );
}

// The session a take belongs to: the host's process when it names one that runs, else none (ttl only).
function sessionPid() {
  const pid = Number(process.env.CLAUDE_PID);
  return Number.isInteger(pid) && pid > 0 && running(pid) ? pid : null;
}

/** `agentry lock …` (argv after the group): the exit code. */
export async function lockCli(argv) {
  const [sub, ...args] = argv;
  if (sub === undefined || sub === "--help" || sub === "-h" || args.includes("--help")) {
    process.stdout.write(`${renderHelp("agentry", "lock", LOCK_HELP)}\n`);
    return 0;
  }
  const what = `agentry lock ${sub}`;
  const out = (code, line) => {
    (code === 2 ? process.stderr : process.stdout).write(`${line}\n`);
    return code;
  };
  if (!["take", "drop", "show"].includes(sub))
    return out(
      2,
      say("agentry lock", `unknown subcommand "${sub}" (take, drop, show)`, "agentry lock --help"),
    );
  const takes = { take: ["--for", "--ttl", "--wait"], drop: ["--for"], show: [] }[sub];
  const orphan = sub === "drop" && args.includes("--orphan");
  const parsed = optionsOf(
    args.filter((arg) => !(orphan && arg === "--orphan")),
    what,
    [...takes, "--root", "--process"],
  );
  if (parsed.err) return out(2, parsed.err);
  const { got, rest } = parsed;
  const { root, lane } = placeOf(got["--root"]);
  const declared = declaredLocks(root, got["--process"], what);
  if (declared.err) return out(2, declared.err);
  if (sub === "show") {
    if (rest.length) return out(2, say(what, "takes no name", `${what} --help`));
    return out(0, showLines(root, declared));
  }
  if (rest.length !== 1) return out(2, say(what, "name one lock", `${what} --help`));
  const [name] = rest;
  const lock = lockNamed(name, declared, what);
  if (lock.err) return out(2, lock.err);
  const who = takerOf(got["--for"], lane);
  const pid = sessionPid();
  if (orphan) return out(...orphansDropped(root, name, lock.slots, what));
  if (sub === "drop") {
    const { dropped, kept } = dropLock(root, name, { slots: lock.slots, pid, who });
    if (kept !== null) return out(0, `lock ${name}: kept while your run (pid ${kept}) rides it`);
    if (dropped) return out(0, `lock ${name} dropped`);
    return out(1, say(what, `${name} is not held by ${who}`, "agentry lock show"));
  }
  const ttlText = got["--ttl"] ?? TAKE_TTL;
  const ttlMs = durationMs(ttlText);
  if (ttlMs === null)
    return out(
      2,
      say(
        what,
        `--ttl "${ttlText}" is not a time: <n>s, <n>m or <n>h, n above 0`,
        `${what} --help`,
      ),
    );
  const waitMs = waitOf(got, what);
  if (waitMs.err) return out(2, waitMs.err);
  const taken = await acquire(root, name, waitMs, { slots: lock.slots, pid, who, ttlMs });
  if (taken.busy) {
    process.stderr.write(`${busyLine("lock take", name, taken.busy)}\n`);
    return BUSY_EXIT;
  }
  const until = clock(new Date(Date.now() + ttlMs).toISOString());
  return out(
    0,
    `lock ${name} taken by ${who} until ${until} → agentry lock drop ${name}${got["--for"] ? ` --for ${who}` : ""}`,
  );
}

// `lock drop --orphan`: `[exit, line]` after freeing the slots only a leftover group holds.
function orphansDropped(root, name, slots, what) {
  const { freed, alive } = dropOrphans(root, name, slots);
  if (freed.length)
    return [
      0,
      `lock ${name}: freed the slot of pgid ${freed.join(", ")} (still running: kill -- -${freed[0]} stops it)`,
    ];
  if (alive !== null)
    return [
      1,
      say(what, `${name}: its run (pid ${alive}) still lives, not an orphan`, "agentry lock show"),
    ];
  return [1, say(what, `${name} has no leftover group to free`, "agentry lock show")];
}

// `lock show`: one line per declared lock, its holders after it.
function showLines(root, { locks, file }) {
  const names = Object.keys(locks);
  if (!names.length) return `no locks in ${file} → add "locks": { "editor": 1 } (format.md)`;
  return names
    .flatMap((name) => {
      const held = heldLocks(root, name, locks[name]);
      const head = `${name} ${held.length}/${locks[name]}${held.length ? "" : ": free"}`;
      return [
        head,
        ...held.map(
          (h) =>
            `  slot ${h.slot}: ${h.who || "unknown"} since ${h.since}${h.until ? `, until ${h.until}` : ""}${h.pid ? ` (pid ${h.pid})` : ""}${h.orphan ? `, orphan: pgid ${h.orphan} still running` : ""}`,
        ),
      ];
    })
    .join("\n");
}
