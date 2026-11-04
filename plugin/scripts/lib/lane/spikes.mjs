// spikes — the agent worktrees the owner filed (field 87): `.agentry/run/spikes.json` in the main checkout,
// a list of `{ branch, path, for?, keep?, at }`, one per branch. `for` names the board item the work is
// meant for; `keep` is why it is kept on purpose. Local run state, not the board: written whole through
// `fs/atomic.mjs`, so a killed writer leaves the old list or the new, never a part. `drift.mjs` reads it
// to show a filed worktree as kept or as work for its item, never as an unlisted one. Node built-ins only.
//
// spikesFile(root) -> path
// readSpikes(root) -> { spikes } | { error }      `[]` when there is no file
// fileSpike(root, entry) -> spikes                the entry for its branch replaced (or added)
// forgetSpike(root, entry) -> spikes              the entry for its branch dropped
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

/** File `entry` (`{ branch, path, for? | keep?, at }`), in place of any entry for its branch. Throws when
 *  the file is there but unusable (it is never overwritten then). */
export function fileSpike(root, entry) {
  const { spikes, error } = readSpikes(root);
  if (error) throw new Error(error);
  const at = spikes.findIndex((s) => s.branch === entry.branch);
  return write(root, at < 0 ? [...spikes, entry] : spikes.with(at, entry));
}

/** Drop the entry for `entry.branch`. Throws as `fileSpike` does. */
export function forgetSpike(root, entry) {
  const { spikes, error } = readSpikes(root);
  if (error) throw new Error(error);
  return write(
    root,
    spikes.filter((s) => s.branch !== entry.branch),
  );
}
