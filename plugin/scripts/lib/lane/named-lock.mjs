// named-lock — the workflow file's `locks` (`{ "editor": 1 }`): a lock with that many slots, held by
// `agentry run --lock <name>` for a command's life, or by `agentry lock take <name>` for an MCP-driven
// session. A slot is a file `slot-<n>.lock` under `.agentry/run/locks/<name>/` of the main checkout (every
// worktree shares it), created with `wx` (one creator wins), holding `{ pid, who, at, until? }`. A slot is
// free again once its pid is gone, once its `until` has passed (a take's ttl), or, holding neither a pid
// nor an until, once it is old enough not to be mid-write. The pid, holder and clock checks are gate-lock's.
// A run also records its command's process group (`pgid`): while any member of that group lives the slot
// stays held, even after `agentry run` itself died (an orphan). A run riding a take extends its `until`
// to cover the command and records itself in `riders` (the take's own `until` in `ownUntil`): the extension
// ends with the last live rider, and a drop while one lives is kept until then. Synchronous: a waiting
// caller polls `tryLock` at `POLL_MS`. Node built-ins only.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isObject, own } from "../process/spec/shape.mjs";
import {
  GRACE_MS,
  clock,
  groupRunning,
  holderOf as parsedHolderOf,
  running,
} from "./gate-lock.mjs";

export { POLL_MS } from "./gate-lock.mjs";

/** The directory lock `name`'s slots live in. */
export const lockDir = (root, name) => join(root, ".agentry", "run", "locks", name);

/** The locks the workflow file declares, `{ name: capacity }` (`{}` when it has none). */
export const locksOf = (spec) => {
  const locks = own(spec, "locks");
  return isObject(locks) ? locks : {};
};

// The group an orphaned slot's command left running: the holder's pid is gone, its group is not.
const orphanGroup = (holder) =>
  Number.isInteger(holder?.pid) && !running(holder.pid) && groupRunning(holder.pgid)
    ? holder.pgid
    : null;

// The pids of a take's riders that still run.
const liveRiders = (holder) => (holder?.riders ?? []).filter((pid) => running(pid));

// A slot's holder as it stands now: a take whose riders are all gone is back at its own `until`.
function holderOf(file) {
  const holder = parsedHolderOf(file);
  if (!holder?.riders || liveRiders(holder).length) return holder;
  const { riders, ownUntil, ...take } = holder;
  return { ...take, until: ownUntil };
}

const slotFile = (root, name, n) => join(lockDir(root, name), `slot-${n}.lock`);

const textOf = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

// Can nobody be holding the slot `file` (read as `holder`) any more?
function free(file, holder, now) {
  if (holder?.until !== undefined && !(Date.parse(holder.until) > now)) return true;
  if (Number.isInteger(holder?.pid)) return !running(holder.pid) && orphanGroup(holder) === null;
  if (holder?.until !== undefined) return false;
  try {
    return now - statSync(file).mtimeMs > GRACE_MS;
  } catch {
    return false;
  }
}

// Take slot `n` with `entry` (JSON text): true when it is ours now. A free slot is taken over, removed
// only while it still holds what was read, so a slot another taker just won is never removed.
function takeSlot(root, name, n, entry, now) {
  const file = slotFile(root, name, n);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, entry, { flag: "wx" });
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const seen = textOf(file);
    if (seen === null) continue;
    if (!free(file, holderOf(file), now)) return false;
    if (textOf(file) === seen) rmSync(file, { force: true });
  }
  return false;
}

const holding = (holder, slot) => ({
  slot,
  pid: Number.isInteger(holder.pid) ? holder.pid : null,
  who: holder.who ?? "",
  since: clock(holder.at),
  ...(orphanGroup(holder) !== null && { orphan: holder.pgid }),
  ...(holder.until !== undefined && { until: clock(holder.until) }),
});

/** The slots of lock `name` (capacity `slots`) held now: `[{ slot, pid, who, since, until?, orphan? }]`,
 *  `since` and `until` as HH:MM, `orphan` the group still running after its run died. A slot past the capacity counts for nothing. */
export function heldLocks(root, name, slots, now = Date.now()) {
  const held = [];
  for (let n = 1; n <= slots; n++) {
    const file = slotFile(root, name, n);
    const holder = holderOf(file);
    if (holder && !free(file, holder, now)) held.push(holding(holder, n));
  }
  return held;
}

// Is `holder` a take by this same session (`pid`, null when it has none) for this same `who`?
const sameTake = (holder, pid, who) =>
  holder?.until !== undefined && holder.pid === pid && holder.who === who;

/** The slot of lock `name` a take by session `pid` (null: none) for `who` holds now, or null: a command
 *  of that session and lane runs inside it. */
export function ownTake(root, name, { slots, pid, who, now = Date.now() }) {
  for (let n = 1; n <= slots; n++) {
    const file = slotFile(root, name, n);
    const holder = holderOf(file);
    if (sameTake(holder, pid, who) && !free(file, holder, now)) return n;
  }
  return null;
}

/**
 * One try for a slot of lock `name` (capacity `slots`): `{ slot }` once held, or `{ busy: { who, since } }`
 * naming a holder. `pid` is the holder's process (a run's own; a take's session, or null: then only the
 * ttl frees it); `ttlMs` makes it a take, which ends at `until`. A session that takes again for the same
 * `who` keeps its slot with the new ttl (`again: true`).
 */
export function tryLock(
  root,
  name,
  { slots, pid = process.pid, who = "", ttlMs = null, now = Date.now() },
) {
  mkdirSync(lockDir(root, name), { recursive: true });
  const entry = {
    pid,
    who,
    at: new Date(now).toISOString(),
    ...(ttlMs !== null && { until: new Date(now + ttlMs).toISOString() }),
  };
  if (ttlMs !== null)
    for (let n = 1; n <= slots; n++) {
      const file = slotFile(root, name, n);
      const holder = holderOf(file);
      if (sameTake(holder, pid, who) && !free(file, holder, now)) {
        const rides = liveRiders(holder).length
          ? { riders: holder.riders, ownUntil: entry.until, until: holder.until }
          : {};
        writeFileSync(file, JSON.stringify({ ...entry, at: holder.at, ...rides }));
        return { slot: n, again: true };
      }
    }
  for (let n = 1; n <= slots; n++)
    if (takeSlot(root, name, n, JSON.stringify(entry), now)) return { slot: n };
  const [first] = heldLocks(root, name, slots, now);
  return { busy: { who: first?.who || "unknown", since: first?.since ?? "?" } };
}

/** Record the process group `pgid` of the command that holds slot `slot` (taken by this process): the
 *  slot stays held while that group runs, whether or not this process does. */
export function setGroup(root, name, slot, pgid, pid = process.pid) {
  const file = slotFile(root, name, slot);
  const holder = holderOf(file);
  if (holder?.pid === pid) writeFileSync(file, JSON.stringify({ ...holder, pgid }));
}

/** Keep the take in slot `slot` of lock `name` until at least `untilMs`, for the command of process `pid`
 *  riding it (a command must not outlive its take); `endRide` takes the extension back. */
export function extendTake(root, name, slot, untilMs, pid = process.pid) {
  const file = slotFile(root, name, slot);
  const holder = holderOf(file);
  if (holder?.until === undefined) return;
  const riders = [...new Set([...liveRiders(holder), pid])];
  const until = new Date(Math.max(untilMs, Date.parse(holder.until))).toISOString();
  writeFileSync(
    file,
    JSON.stringify({ ...holder, riders, ownUntil: holder.ownUntil ?? holder.until, until }),
  );
}

/** The ride of process `pid` on the take in slot `slot` ends: with no other rider left, the take is back at
 *  its own `until` (and gone, when that has passed: a drop that was kept for the ride). */
export function endRide(root, name, slot, pid = process.pid) {
  const file = slotFile(root, name, slot);
  const holder = parsedHolderOf(file);
  if (!holder?.riders?.includes(pid)) return;
  const riders = holder.riders.filter((p) => p !== pid && running(p));
  if (riders.length) return writeFileSync(file, JSON.stringify({ ...holder, riders }));
  const { riders: _, ownUntil, ...take } = holder;
  if (Date.parse(ownUntil) > Date.now())
    writeFileSync(file, JSON.stringify({ ...take, until: ownUntil }));
  else rmSync(file, { force: true });
}

/** Free slot `slot` of lock `name` when process `pid` still holds it (a slot taken over since is left),
 *  unless the group of the command it ran still has a member: then the slot stays held as an orphan. */
export function releaseLock(root, name, slot, pid = process.pid) {
  const file = slotFile(root, name, slot);
  const holder = holderOf(file);
  if (holder?.pid === pid && !groupRunning(holder.pgid)) rmSync(file, { force: true });
}

/** Drop the takes of lock `name` this session (`pid`) holds for `who`: `{ dropped }` the slots it freed at
 *  once, `kept` the pid of a live run riding one of them (that slot goes when the ride ends). */
export function dropLock(root, name, { slots, pid, who }) {
  let dropped = 0;
  let kept = null;
  for (let n = 1; n <= slots; n++) {
    const file = slotFile(root, name, n);
    const holder = holderOf(file);
    if (holder?.until === undefined || holder.pid !== pid || holder.who !== who) continue;
    const [rider] = liveRiders(holder);
    if (rider === undefined) {
      rmSync(file, { force: true });
      dropped++;
    } else {
      writeFileSync(file, JSON.stringify({ ...holder, ownUntil: new Date().toISOString() }));
      kept ??= rider;
    }
  }
  return { dropped, kept };
}

/** Free the slots of lock `name` held only by a leftover group (the recording pid is gone, the group runs):
 *  `{ freed }` their pgids, `alive` the pid of a recording process that still runs (its slot is left). */
export function dropOrphans(root, name, slots) {
  const freed = [];
  let alive = null;
  for (let n = 1; n <= slots; n++) {
    const file = slotFile(root, name, n);
    const holder = holderOf(file);
    if (!groupRunning(holder?.pgid)) continue;
    if (running(holder.pid)) alive ??= holder.pid;
    else {
      rmSync(file, { force: true });
      freed.push(holder.pgid);
    }
  }
  return { freed, alive };
}
