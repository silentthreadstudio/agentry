// spikes — reading the agent worktrees the owner filed: `.agentry/run/spikes.json` in the main
// checkout, a list of `{ branch, path, for?, keep?, at, calls? }`, one per branch. `drift.mjs` reads it to
// show a filed worktree as kept or as work for its item, never as an unlisted one; the lanes read it too.
// The writes are `lane/spikes.mjs`'s. Node built-ins only.
//
// spikesFile(root) -> path
// readSpikes(root) -> { spikes } | { error }      `[]` when there is no file
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
