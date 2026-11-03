// named-lock — the workflow file's `locks` (`{ "editor": 1 }`): a lock with that many slots, held by
// `agentry run --lock <name>` for a command's life, or by `agentry lock take <name>` for an MCP-driven
// session. A slot is a file `slot-<n>.lock` under `.agentry/run/locks/<name>/` of the main checkout (every
// worktree shares it), created with `wx` (one creator wins), holding `{ pid, who, at, until? }`. A slot is
// free again once its pid is gone, once its `until` has passed (a take's ttl), or, holding neither a pid
// nor an until, once it is old enough not to be mid-write. The pid, holder and clock checks are gate-lock's.
// Synchronous: a waiting caller polls `tryLock` at `POLL_MS`. Node built-ins only.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isObject, own } from "../process/spec/shape.mjs";
import { GRACE_MS, clock, holderOf, running } from "./gate-lock.mjs";

export { POLL_MS } from "./gate-lock.mjs";

/** The directory lock `name`'s slots live in. */
export const lockDir = (root, name) => join(root, ".agentry", "run", "locks", name);

/** The locks the workflow file declares, `{ name: capacity }` (`{}` when it has none). */
export const locksOf = (spec) => {
  const locks = own(spec, "locks");
  return isObject(locks) ? locks : {};
};

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
  if (Number.isInteger(holder?.pid)) return !running(holder.pid);
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
  ...(holder.until !== undefined && { until: clock(holder.until) }),
});

/** The slots of lock `name` (capacity `slots`) held now: `[{ slot, pid, who, since, until? }]`, `since`
 *  and `until` as HH:MM. A slot past the capacity counts for nothing. */
export function heldLocks(root, name, slots, now = Date.now()) {
  const held = [];
  for (let n = 1; n <= slots; n++) {
    const file = slotFile(root, name, n);
    const holder = holderOf(file);
    if (holder && !free(file, holder, now)) held.push(holding(holder, n));
  }
  return held;
}

// Is `holder` a take by this same session (`pid`) for this same `who`?
const sameTake = (holder, pid, who) =>
  holder?.until !== undefined && pid !== null && holder.pid === pid && holder.who === who;

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
        writeFileSync(file, JSON.stringify({ ...entry, at: holder.at }));
        return { slot: n, again: true };
      }
    }
  for (let n = 1; n <= slots; n++)
    if (takeSlot(root, name, n, JSON.stringify(entry), now)) return { slot: n };
  const [first] = heldLocks(root, name, slots, now);
  return { busy: { who: first?.who || "unknown", since: first?.since ?? "?" } };
}

/** Free slot `slot` of lock `name` when process `pid` still holds it (a slot taken over since is left). */
export function releaseLock(root, name, slot, pid = process.pid) {
  const file = slotFile(root, name, slot);
  if (holderOf(file)?.pid === pid) rmSync(file, { force: true });
}

/** Drop the takes of lock `name` this session (`pid`) holds for `who`: how many slots it freed. */
export function dropLock(root, name, { slots, pid, who }) {
  let dropped = 0;
  for (let n = 1; n <= slots; n++) {
    const file = slotFile(root, name, n);
    const holder = holderOf(file);
    if (holder?.until !== undefined && holder.pid === pid && holder.who === who) {
      rmSync(file, { force: true });
      dropped++;
    }
  }
  return dropped;
}
