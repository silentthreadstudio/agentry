// owner-calls — the owner's calls made on a lane or a spike (field 90), so none is left only in a chat:
// `calls[]` of the item's ledger, or of the spike filed for it in `spikes.json`, each `{ n, at, text,
// recorded }`, `recorded` null until the call is written down where the repo keeps decisions (`{ at, where }`).
// A lane's ledger and a spike are the holders of an item's calls; `lane note` appends to the open ledger,
// else to the spike, and marks them; `exec adopt` moves a spike's calls into the new ledger (`adopt.mjs`);
// `session close` lists those not written down. Writes go through `ledger.mjs` and `spikes.mjs`, both whole
// files (`fs/atomic.mjs`); a file that cannot be read is named, never written over. Node built-ins only.
//
// callProblem(text) -> why `text` is no call, or null
// holderName(holder) -> `the lane` | `spike <branch>`
// holdersOf(root, id, { appending }) -> { holders: [Holder] } | { problem }
// added(calls, text, at) -> calls with the next `n`
// marked(holders, which, { at, where }) -> { writes: [{ holder, calls }], marked } | { problem }
// saveCalls(root, holder, calls)                     the holder's file written with `calls`
// spikeCalls(root, { id, branch }) -> { calls } | { problem }   the calls of the spike filed for `id` on it
// openCalls(root) -> { calls: [{ id, open: [{ n, text }] }], errors }   every holder's, any lane state
// callLines(calls) -> the close lines, one per id (at most MAX_IDS, then `+N more`)
// callsLine(ledger) -> `owner calls: <k> (<j> written down)`, or null with none
//
// Holder: `{ on: "lane", id, file, state, calls }` | `{ on: "spike", branch, calls }`.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as ledgers from "../process/ledger.mjs";
import { readSpikes, spikesFile } from "../process/spikes.mjs";
import { setSpikeCalls } from "./spikes.mjs";

const MAX_IDS = 3;

const ledgerDir = (root) => join(root, ".agentry", "run", "process", "ledger");
const ledgerFile = (root, id) => join(ledgerDir(root), `${id}.json`);
const isOpen = (l) => l.state !== "merged" && l.state !== "closed";
const isCall = (c) =>
  c !== null && typeof c === "object" && Number.isInteger(c.n) && typeof c.text === "string";
// The calls `list` holds (none when absent), or null when it is there but not a list of calls.
const callsIn = (list) =>
  list === undefined ? [] : Array.isArray(list) && list.every(isCall) ? list : null;
const notCalls = (file) => `${file} holds calls that are not a list of { n, text }: fix it`;

/** Why `text` cannot be one call: empty, more than one line (any line or paragraph break, U+2028 and
 *  U+0085 too), or holding a control character (C0, DEL, C1: an escape would reach the terminal). null
 *  when it can. */
export function callProblem(text) {
  if (typeof text !== "string" || !text.trim()) return "the call is empty";
  if (/[\r\n\u0085\u2028\u2029]/u.test(text))
    return "the call is more than one line: give one call per note";
  if (/\p{Cc}/u.test(text)) return "the call holds a control character: give it as plain text";
  return null;
}

// The ledger of `id` as a holder (null: none), or `{ problem }` when its file is torn or its calls are not.
function ledgerHolder(root, id) {
  let ledger;
  try {
    ledger = ledgers.read(root, id);
  } catch (e) {
    return { problem: e.message };
  }
  if (!ledger) return null;
  const file = ledgerFile(root, id);
  const calls = callsIn(ledger.calls);
  return calls ? { on: "lane", id, file, state: ledger.state, calls } : { problem: notCalls(file) };
}

// The spikes filed for `id` as holders, or `{ problem }` when `spikes.json` or an entry's calls are not usable.
function spikeHolders(root, id) {
  const { spikes, error } = readSpikes(root);
  if (error) return { problem: error };
  const holders = [];
  for (const s of spikes.filter((s) => s.for === id)) {
    const calls = callsIn(s.calls);
    if (!calls) return { problem: notCalls(spikesFile(root)) };
    holders.push({ on: "spike", branch: s.branch, calls });
  }
  return { holders };
}

/** Where `id`'s calls are. `appending`: the one a new call goes to, the open ledger, else the spike filed
 *  for `id` (more than one such spike is refused: which one the call is about is not known). Otherwise
 *  every holder: the ledger in any state, then the spikes. `{ problem }` when there is none, or when a file
 *  it needs cannot be read (it is never written then). */
export function holdersOf(root, id, { appending = false } = {}) {
  const lane = ledgerHolder(root, id);
  if (lane?.problem) return { problem: lane.problem };
  if (appending && lane && isOpen(lane)) return { holders: [lane] };
  const spikes = spikeHolders(root, id);
  if (spikes.problem) return { problem: spikes.problem };
  const holders = appending ? spikes.holders : [...(lane ? [lane] : []), ...spikes.holders];
  if (!holders.length && appending && lane)
    return {
      problem: `${id}'s lane is ${lane.state}: file a spike --for ${id} to note on it, or exec adopt`,
    };
  if (!holders.length)
    return {
      problem: `${id} has no lane or spike`,
      next: `lane spike <branch> --for ${id}, or exec adopt`,
    };
  if (appending && holders.length > 1)
    return {
      problem: `${id} has spikes on ${holders.map((h) => h.branch).join(", ")}: file all but the one the call is about with --keep`,
      next: 'lane spike <branch> --keep "<why>"',
    };
  return { holders };
}

/** `calls` with `text` appended as the next call, numbered one past the highest. */
export const added = (calls, text, at) => [
  ...calls,
  { n: Math.max(0, ...calls.map((c) => c.n)) + 1, at, text, recorded: null },
];

/** Mark the calls `which` names (`"all"`: every one not written down, in every holder; else a list of
 *  numbers, each found in exactly one holder) as written down at `where`. A call already marked keeps its
 *  record. `{ writes, marked }` (the numbers marked now), or `{ problem }` for a number no holder has, or
 *  one that two holders share (then nothing is written). */
export function marked(holders, which, { at, where }) {
  const record = { at, where: where ?? null };
  const writes = [];
  const done = [];
  if (which === "all") {
    for (const holder of holders) {
      const now = holder.calls.filter((c) => !c.recorded).map((c) => c.n);
      if (!now.length) continue;
      done.push(...now);
      writes.push({
        holder,
        calls: holder.calls.map((c) => (c.recorded ? c : { ...c, recorded: record })),
      });
    }
    return { writes, marked: done };
  }
  const wanted = new Map();
  for (const n of which) {
    const owners = holders.filter((h) => h.calls.some((c) => c.n === n));
    if (!owners.length) return { problem: `no call ${n}` };
    if (owners.length > 1)
      return {
        problem: `call ${n} is on ${owners.map(holderName).join(" and ")}: mark them with all`,
      };
    wanted.set(owners[0], [...(wanted.get(owners[0]) ?? []), n]);
  }
  for (const [holder, ns] of wanted) {
    const now = holder.calls.filter((c) => ns.includes(c.n) && !c.recorded).map((c) => c.n);
    if (!now.length) continue;
    done.push(...now);
    writes.push({
      holder,
      calls: holder.calls.map((c) => (now.includes(c.n) ? { ...c, recorded: record } : c)),
    });
  }
  return { writes, marked: done };
}

/** A holder in a message: `the lane` or `spike <branch>`. */
export const holderName = (h) => (h.on === "lane" ? "the lane" : `spike ${h.branch}`);

/** Write `calls` to the holder's file, whole. Throws when the file became unusable meanwhile. */
export function saveCalls(root, holder, calls) {
  if (holder.on === "spike") return setSpikeCalls(root, holder.branch, calls);
  return ledgers.write(root, { ...ledgers.read(root, holder.id), calls });
}

/** The calls of the spike filed for `id` on `branch` (none when no such spike, or it has none), or
 *  `{ problem }` when `spikes.json` cannot be read. */
export function spikeCalls(root, { id, branch }) {
  const { spikes, error } = readSpikes(root);
  if (error) return { problem: error };
  const spike = spikes.find((s) => s.branch === branch && s.for === id);
  const calls = callsIn(spike?.calls);
  return calls ? { calls } : { problem: notCalls(spikesFile(root)) };
}

// The ledger files that cannot be read at all (torn, unreadable): `<path> unreadable` each. A file that
// parses is skipped here, whatever it holds: an older restart's flat archive (`<id>.<n>.json`) is one,
// and its calls went to the new ledger. A restart's archive now sits in `ledger/.archive/`, outside this
// listing.
function unreadableLedgers(root, listed) {
  let names;
  try {
    names = readdirSync(ledgerDir(root));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".json") && !listed.has(n.slice(0, -".json".length)))
    .map((n) => join(ledgerDir(root), n))
    .filter((file) => {
      try {
        JSON.parse(readFileSync(file, "utf8"));
        return false;
      } catch {
        return true;
      }
    })
    .map((file) => `${file} unreadable`);
}

/** The calls not written down of every ledger (merged and closed ones too) and every spike filed for an
 *  item, one entry per id, the ledger's first. `errors`: each ledger file that cannot be read, and why
 *  `spikes.json` was not read. */
export function openCalls(root) {
  const byId = new Map();
  const add = (id, calls) => {
    const open = (callsIn(calls) ?? [])
      .filter((c) => !c.recorded)
      .map(({ n, text }) => ({ n, text }));
    if (open.length) byId.set(id, [...(byId.get(id) ?? []), ...open]);
  };
  const all = ledgers.list(root);
  for (const l of all) add(l.id, l.calls);
  const errors = unreadableLedgers(root, new Set(all.map((l) => l.id)));
  const { spikes, error } = readSpikes(root);
  for (const s of spikes ?? []) if (s.for) add(s.for, s.calls);
  const calls = [...byId].map(([id, open]) => ({ id, open }));
  return { calls, errors: error ? [...errors, error] : errors };
}

/** The lines `session close` gives for `calls`: one per id, at most MAX_IDS, then how many more. */
export function callLines(calls) {
  const lines = calls
    .slice(0, MAX_IDS)
    .map(
      ({ id, open }) =>
        `calls: ${id} ${open.length} not written down → write them to the decisions or sprint file, then lane note ${id} --recorded all`,
    );
  if (calls.length > MAX_IDS) lines.push(`calls: +${calls.length - MAX_IDS} more`);
  return lines;
}

/** What the lane's episode says about its owner's calls: `owner calls: <k> (<j> written down)`. */
export function callsLine(ledger) {
  const calls = callsIn(ledger.calls) ?? [];
  if (!calls.length) return null;
  return `owner calls: ${calls.length} (${calls.filter((c) => c.recorded).length} written down)`;
}
