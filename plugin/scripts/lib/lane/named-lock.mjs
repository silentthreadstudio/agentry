// named-lock — the workflow file's `locks` (`{ "editor": 1 }`): a lock with that many slots, held by
// `agentry run --lock <name>` for a command's life, or by `agentry lock take <name>` for an MCP-driven
// session. A slot is a file `slot-<n>.lock` under `.agentry/run/locks/<name>/` of the main checkout (every
// worktree shares it), holding `{ pid, start, who, at, until? }`: `pid` and `start` name the holder so that a
// reused pid does not pass for it (`process/pid.mjs`; a record with no `start` is read by its pid). It is
// always written whole (`fs/atomic.mjs`, so no reader sees it half-written) and only inside its write mutex
// `slot-<n>.lock.write` (gate-lock's `serialized`), so one taker wins and no rewrite loses another's. A slot is
// free again once its holder is gone, once its `until` has passed (a take's ttl), or, holding neither a pid
// nor an until, once it is old enough not to be mid-write. A run also records its command's process group
// (`pgid`, `pgStart` its leader's start): while any member of that group lives the slot stays held, even after
// `agentry run` itself died (an orphan). A run riding a take extends its `until` to cover the command and
// records itself in `riders` as `{ pid, start, pgid, pgStart }` (the take's own `until` in `ownUntil`): a
// rider lives while its run or its command's group does, and while one lives the take is held, past any
// `until` (an orphaned ride, like an orphaned run). The extension ends with the last live rider, and a drop
// while one lives is kept until then. Every reader sweeps the dead writers' temp files first; `staleLockSlots`
// lists for the sweep (without sweeping: its preview changes nothing) the slots whose holder and riders are
// gone, with the groups they left running, and `clearLockSlot` removes one. Synchronous: a waiting caller
// polls `tryLock` at `POLL_MS`. Node built-ins only.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { atomicWrite, deadTemps, sweepTemps } from "../fs/atomic.mjs";
import { identity } from "../process/pid.mjs";
import { isObject, own } from "../process/spec/shape.mjs";
import {
  GRACE_MS,
  clock,
  heldHere,
  holderAlive,
  liveGroup,
  holderOf as parsedHolderOf,
  recordOf,
  serialized,
} from "./gate-lock.mjs";

export { POLL_MS } from "./gate-lock.mjs";

/** The directory lock `name`'s slots live in. */
export const lockDir = (root, name) => join(root, ".agentry", "run", "locks", name);

/** The locks the workflow file declares, `{ name: capacity }` (`{}` when it has none). */
export const locksOf = (spec) => {
  const locks = own(spec, "locks");
  return isObject(locks) ? locks : {};
};

// The temp files an older version left (`slot-<n>.lock.<pid>.tmp`): swept like the atomic helper's own.
const OLD_TEMP = /^slot-\d+\.lock\.(\d+)\.tmp$/;

// Lock `name`'s directory, its dead writers' temp files swept first: every reader comes through here.
function openDir(root, name) {
  const dir = lockDir(root, name);
  sweepTemps(dir, OLD_TEMP);
  return dir;
}

const slotFile = (dir, n) => join(dir, `slot-${n}.lock`);

const textOf = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

// The group an orphaned slot's command left running: the holder is gone, its group is not.
const orphanGroup = (holder) =>
  Number.isInteger(holder?.pid) && !holderAlive(holder) ? liveGroup(holder) : null;

// A take's riders that still run: the run itself, or (with `groups`) its command's group after the run died.
const liveRiders = (holder, groups = true) =>
  (holder?.riders ?? []).filter(
    (rider) => holderAlive(rider) || (groups && liveGroup(rider) !== null),
  );

// A slot's holder as it stands now: a take whose riders are all gone is back at its own `until`.
function standing(holder, groups = true) {
  if (!holder?.riders || liveRiders(holder, groups).length) return holder;
  const { riders, ownUntil, ...take } = holder;
  return { ...take, until: ownUntil };
}

const holderOf = (file) => standing(parsedHolderOf(file));

// Write slot `file` whole (a temp file renamed over it), so a reader never sees it empty or cut short.
const writeSlot = (file, holder) => atomicWrite(file, JSON.stringify(holder));

// Can nobody be holding the slot `file` (read as `holder`) any more? A take with a live rider is held,
// past its `until` too, the way a run's own slot is held while its group lives. Without `groups`, a group
// left running holds nothing (the sweep's view: it stops that group).
function free(file, holder, now, groups = true) {
  if (liveRiders(holder, groups).length) return false;
  if (holder?.until !== undefined && !(Date.parse(holder.until) > now)) return true;
  if (Number.isInteger(holder?.pid))
    return !holderAlive(holder) && !(groups && liveGroup(holder) !== null);
  if (holder?.until !== undefined) return false;
  try {
    return now - statSync(file).mtimeMs > GRACE_MS;
  } catch {
    return false;
  }
}

// Take slot `n` with `entry`: true when it is ours now (it was empty, or free and taken over).
function takeSlot(dir, n, entry, now) {
  const file = slotFile(dir, n);
  return serialized(file, () => {
    if (textOf(file) !== null && !free(file, holderOf(file), now)) return false;
    writeSlot(file, entry);
    if (entry.pid === process.pid && entry.until === undefined) heldHere(file, true);
    return true;
  });
}

const holding = (holder, slot, now) => {
  const riders = liveRiders(holder);
  const orphanRide = riders.find((rider) => !holderAlive(rider));
  return {
    slot,
    pid: Number.isInteger(holder.pid) ? holder.pid : null,
    who: holder.who ?? "",
    since: clock(holder.at),
    ...(orphanGroup(holder) !== null && { orphan: holder.pgid }),
    ...(holder.until !== undefined && { until: clock(holder.until) }),
    // A take that is over (dropped, or past its own ttl) but kept while a ride lives.
    ...(riders.length && !(Date.parse(holder.ownUntil) > now) && { kept: true }),
    ...(orphanRide && { orphanRide: orphanRide.pgid }),
  };
};

/** The slots of lock `name` (capacity `slots`) held now: `[{ slot, pid, who, since, until?, orphan?, kept?,
 *  orphanRide? }]`, `since` and `until` as HH:MM, `orphan` the group still running after its run died, `kept`
 *  a take that is over but kept for its ride, `orphanRide` the group of a ride whose run died. A slot past the
 *  capacity counts for nothing. */
export function heldLocks(root, name, slots, now = Date.now()) {
  const dir = openDir(root, name);
  const held = [];
  for (let n = 1; n <= slots; n++) {
    const file = slotFile(dir, n);
    const holder = holderOf(file);
    if (holder && !free(file, holder, now)) held.push(holding(holder, n, now));
  }
  return held;
}

// Is `holder` a take by this same session (`pid`, null when it has none) for this same `who`?
const sameTake = (holder, pid, who) =>
  holder?.until !== undefined && holder.pid === pid && holder.who === who;

// The record of process `pid` (null: none) a slot or a ride keeps.
const recordFor = (pid) => (pid === null ? { pid: null } : recordOf(pid));

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
  const dir = openDir(root, name);
  const entry = {
    ...recordFor(pid),
    who,
    at: new Date(now).toISOString(),
    ...(ttlMs !== null && { until: new Date(now + ttlMs).toISOString() }),
  };
  if (ttlMs !== null)
    for (let n = 1; n <= slots; n++) {
      const file = slotFile(dir, n);
      const again = serialized(file, () => {
        const holder = holderOf(file);
        if (!sameTake(holder, pid, who) || free(file, holder, now)) return false;
        const later = new Date(Math.max(Date.parse(holder.until), now + ttlMs)).toISOString();
        const rides = liveRiders(holder).length
          ? { riders: holder.riders, ownUntil: entry.until, until: later }
          : {};
        writeSlot(file, { ...entry, at: holder.at, ...rides });
        return true;
      });
      if (again) return { slot: n, again };
    }
  for (let n = 1; n <= slots; n++) if (takeSlot(dir, n, entry, now)) return { slot: n };
  const [first] = heldLocks(root, name, slots, now);
  return { busy: { who: first?.who || "unknown", since: first?.since ?? "?" } };
}

/** Record the process group `pgid` of the command that holds slot `slot` (taken or ridden by this
 *  process): the slot stays held while that group runs, whether or not this process does. */
export function setGroup(root, name, slot, pgid, pid = process.pid) {
  const file = slotFile(openDir(root, name), slot);
  const { start } = identity(pgid);
  const group = { pgid, ...(start !== null && { pgStart: start }) };
  serialized(file, () => {
    const holder = holderOf(file);
    if (holder?.pid === pid) return writeSlot(file, { ...holder, ...group });
    if (!holder?.riders?.some((rider) => rider.pid === pid)) return;
    const riders = holder.riders.map((rider) =>
      rider.pid === pid ? { ...rider, ...group } : rider,
    );
    writeSlot(file, { ...holder, riders });
  });
}

/** Ride the take of lock `name` that session `session` (null: none) holds now for `who`, if there is one:
 *  keep it until at least `untilMs` for the command of process `pid` (a command must not outlive its take)
 *  and return its slot, or null when there is no such take (any other holder is left as it is). `endRide`
 *  takes the extension back. */
export function rideTake(
  root,
  name,
  { slots, session, who, untilMs, pid = process.pid, now = Date.now() },
) {
  const dir = openDir(root, name);
  for (let n = 1; n <= slots; n++) {
    const file = slotFile(dir, n);
    const rode = serialized(file, () => {
      const holder = holderOf(file);
      if (!sameTake(holder, session, who) || free(file, holder, now)) return false;
      const riders = [...liveRiders(holder).filter((rider) => rider.pid !== pid), recordOf(pid)];
      const until = new Date(Math.max(untilMs, Date.parse(holder.until))).toISOString();
      writeSlot(file, { ...holder, riders, ownUntil: holder.ownUntil ?? holder.until, until });
      return true;
    });
    if (rode) return n;
  }
  return null;
}

/** The ride of process `pid` on the take in slot `slot` ends: with no other rider left, the take is back at
 *  its own `until` (and gone, when that has passed: a drop that was kept for the ride). A ride whose
 *  command left its group running goes on until that group is gone. */
export function endRide(root, name, slot, pid = process.pid) {
  const file = slotFile(openDir(root, name), slot);
  serialized(file, () => {
    const holder = parsedHolderOf(file);
    const mine = holder?.riders?.find((rider) => rider.pid === pid);
    if (!mine || liveGroup(mine) !== null) return;
    const riders = liveRiders({ riders: holder.riders.filter((rider) => rider !== mine) });
    if (riders.length) return writeSlot(file, { ...holder, riders });
    const { riders: _, ownUntil, ...take } = holder;
    if (Date.parse(ownUntil) > Date.now()) writeSlot(file, { ...take, until: ownUntil });
    else rmSync(file, { force: true });
  });
}

/** Free slot `slot` of lock `name` when process `pid` still holds it (a slot taken over since is left),
 *  unless the group of the command it ran still has a member: then the slot stays held as an orphan. */
export function releaseLock(root, name, slot, pid = process.pid) {
  const file = slotFile(openDir(root, name), slot);
  serialized(file, () => {
    const holder = holderOf(file);
    if (holder?.pid === pid && liveGroup(holder) === null) rmSync(file, { force: true });
  });
  if (pid === process.pid) heldHere(file, false);
}

/** Drop the takes of lock `name` this session (`pid`) holds for `who`: `{ dropped }` the slots it freed at
 *  once, `kept` a live ride of one of them (that slot goes when the ride ends): `{ pid }` of its run, or
 *  `{ pgid }` of its command's group once only that is left. */
export function dropLock(root, name, { slots, pid, who }) {
  let dropped = 0;
  let kept = null;
  const dir = openDir(root, name);
  for (let n = 1; n <= slots; n++) {
    const file = slotFile(dir, n);
    serialized(file, () => {
      const holder = holderOf(file);
      if (holder?.until === undefined || holder.pid !== pid || holder.who !== who) return;
      const [rider] = liveRiders(holder);
      if (rider === undefined) {
        rmSync(file, { force: true });
        dropped++;
      } else {
        writeSlot(file, { ...holder, ownUntil: new Date().toISOString() });
        kept ??= holderAlive(rider) ? { pid: rider.pid } : { pgid: rider.pgid };
      }
    });
  }
  return { dropped, kept };
}

/** Free the slots of lock `name` held only by a leftover group (the recording pid is gone, the group runs):
 *  a run's slot, or a take whose riders' runs are all gone, one of them leaving its group running.
 *  `{ freed }` their pgids, `alive` the pid of a recording run that still runs (its slot is left). */
export function dropOrphans(root, name, slots) {
  const freed = [];
  let alive = null;
  const dir = openDir(root, name);
  for (let n = 1; n <= slots; n++) {
    const file = slotFile(dir, n);
    serialized(file, () => {
      const holder = holderOf(file);
      const groups = (holder?.riders ?? [holder]).map(liveGroup).filter((g) => g !== null);
      if (!groups.length) return;
      const live = (holder.riders ?? [holder]).find(holderAlive);
      if (live) alive ??= live.pid;
      else {
        rmSync(file, { force: true });
        freed.push(...groups);
      }
    });
  }
  return { freed, alive };
}

/** The directories of every lock that has one under `.agentry/run/locks/` (declared or not). */
export function lockDirs(root) {
  const base = join(root, ".agentry", "run", "locks");
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(base, entry.name));
  } catch {
    return [];
  }
}

/** The lock slots under `.agentry/run/locks/` whose holder and riders are gone, for the sweep:
 *  `[{ file, lock, slot, groups }]`, `groups` the pgids they left running (the sweep stops them). A take with
 *  no pid within its `until` is held, and never listed. */
export function staleLockSlots(root, now = Date.now()) {
  return lockDirs(root).flatMap((dir) =>
    readdirSync(dir)
      .map((f) => /^slot-(\d+)\.lock$/.exec(f)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((x, y) => x - y)
      .flatMap((slot) => {
        const file = slotFile(dir, slot);
        const raw = parsedHolderOf(file);
        if (textOf(file) === null || !free(file, standing(raw, false), now, false)) return [];
        const groups = [raw, ...(raw?.riders ?? [])].map(liveGroup).filter((g) => g !== null);
        return [{ file, lock: basename(dir), slot, groups: [...new Set(groups)] }];
      }),
  );
}

/** The temp files a killed writer left in the lock directories (both namings), for the sweep's listing. */
export const deadLockTemps = (root) => lockDirs(root).flatMap((dir) => deadTemps(dir, OLD_TEMP));

/** Remove lock slot `file` when nobody holds it any more (its groups gone too), inside its mutex: true when
 *  it was removed. */
export function clearLockSlot(file, now = Date.now()) {
  return serialized(file, () => {
    if (textOf(file) === null || !free(file, holderOf(file), now)) return false;
    rmSync(file, { force: true });
    return true;
  });
}
