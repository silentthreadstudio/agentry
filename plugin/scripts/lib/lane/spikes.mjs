// spikes — the agent worktrees the owner filed (field 87): `.agentry/run/spikes.json` in the main checkout,
// a list of `{ branch, path, for?, keep?, at, calls? }`, one per branch. `for` names the board item the work
// is meant for; `keep` is why it is kept on purpose; `calls` are the owner's calls noted on it (field 90,
// `owner-calls.mjs`), kept when the spike is filed again for the same item: a re-file for another item or
// kept, and a forget, refuse while one is not written down (it would be lost). Local run state, not the board: written whole
// through `fs/atomic.mjs`, so a killed writer leaves the old list or the new, never a part. `drift.mjs`
// reads it to show a filed worktree as kept or as work for its item, never as an unlisted one. Node
// built-ins only.
//
// spikesFile(root) -> path
// readSpikes(root) -> { spikes } | { error }      `[]` when there is no file
// fileSpike(root, entry) -> spikes                the entry for its branch replaced (or added)
// forgetSpike(root, entry) -> spikes              the entry for its branch dropped
// setSpikeCalls(root, branch, calls) -> spikes     the entry's `calls` replaced (dropped when empty)
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite } from "../fs/atomic.mjs";

/** Where the filed spikes live, under the main checkout. */
export const spikesFile = (root) => join(root, ".agentry", "run", "spikes.json");

const isEntry = (e) =>
  e !== null && typeof e === "object" && typeof e.branch === "string" && typeof e.path === "string";

/** The filed spikes: `{ spikes }` (none when the file is missing), or `{ error }` when it is there but
 *  is not a list of entries. */
export function readSpikes(root) {
  const file = spikesFile(root);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { spikes: [] };
    return { error: `${file} cannot be read: ${e.message}` };
  }
  try {
    const list = JSON.parse(text);
    if (Array.isArray(list) && list.every(isEntry)) return { spikes: list };
  } catch {}
  return { error: `${file} is not a list of { branch, path } entries: fix or remove it` };
}

function write(root, spikes) {
  const file = spikesFile(root);
  mkdirSync(dirname(file), { recursive: true });
  atomicWrite(file, `${JSON.stringify(spikes, null, 2)}\n`);
  return spikes;
}

// The refusal for dropping `spike`'s owner's calls not written down yet, or null when it has none.
function openCallsProblem(spike) {
  const open = Array.isArray(spike.calls) ? spike.calls.filter((c) => !c?.recorded) : [];
  if (!open.length) return null;
  const which = open.length === 1 ? open[0].n : "all";
  return `${spike.branch} has ${open.length} open owner call(s) for ${spike.for}: lane note ${spike.for} --recorded ${which} first`;
}

/** File `entry` (`{ branch, path, for? | keep?, at }`), in place of any entry for its branch, whose owner's
 *  calls it keeps. Throws when the file is there but unusable (it is never overwritten then), and when the
 *  entry it replaces has calls not written down and `entry` is not for the same item (nothing written). */
export function fileSpike(root, entry) {
  const { spikes, error } = readSpikes(root);
  if (error) throw new Error(error);
  const at = spikes.findIndex((s) => s.branch === entry.branch);
  if (at < 0) return write(root, [...spikes, entry]);
  const old = spikes[at];
  const problem = entry.for === old.for ? null : openCallsProblem(old);
  if (problem) throw new Error(problem);
  return write(root, spikes.with(at, old.calls ? { ...entry, calls: old.calls } : entry));
}

/** Drop the entry for `entry.branch`. Throws as `fileSpike` does, and when the entry has owner's calls not
 *  written down (nothing written). */
export function forgetSpike(root, entry) {
  const { spikes, error } = readSpikes(root);
  if (error) throw new Error(error);
  const problem = openCallsProblem(spikes.find((s) => s.branch === entry.branch) ?? {});
  if (problem) throw new Error(problem);
  return write(
    root,
    spikes.filter((s) => s.branch !== entry.branch),
  );
}

/** Replace the owner's calls of the entry for `branch` (`calls` empty: the field is dropped). Throws as
 *  `fileSpike` does, and when no entry is filed for `branch`. */
export function setSpikeCalls(root, branch, calls) {
  const { spikes, error } = readSpikes(root);
  if (error) throw new Error(error);
  const at = spikes.findIndex((s) => s.branch === branch);
  if (at < 0) throw new Error(`no spike is filed for ${branch} in ${spikesFile(root)}`);
  const { calls: _, ...entry } = spikes[at];
  return write(root, spikes.with(at, calls.length ? { ...entry, calls } : entry));
}
