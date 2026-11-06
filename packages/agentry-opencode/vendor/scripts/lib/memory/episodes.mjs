// episodes — a lane's episodes in the memory store of the repo at `projectDir` (its main checkout):
// `lane exec close` records one through the memory service, and asks whether a stamped id names one. The
// files are `<root>/episodes/<slug>-<ulid>.md`, the id `p:<ulid>` or `g:<ulid>`.
//
// recordEpisode(projectDir, payload, env?) -> { id }   payload as `agentry mem episode` takes it
// episodeStored(projectDir, id) -> boolean
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openMemory } from "./open.mjs";
import { memoryRoots } from "./recall.mjs";
import { rootsAt } from "./resolution/roots.mjs";

const bare = (id) => (id.includes(":") ? id.slice(id.indexOf(":") + 1) : id);

/** Write `payload` as an episode in `projectDir`'s store (the global root from `env`, as the CLI's). */
export function recordEpisode(projectDir, payload, env = process.env) {
  return openMemory(rootsAt(projectDir, env)).episodeWrite(payload);
}

/** True when either memory root (project, global) holds an episode file for `id`. */
export function episodeStored(projectDir, id) {
  const suffix = `-${bare(String(id))}.md`;
  return memoryRoots(projectDir).some(({ dir }) => {
    const episodes = join(dir, "episodes");
    if (!existsSync(episodes)) return false;
    try {
      return readdirSync(episodes).some((f) => f.endsWith(suffix));
    } catch {
      return false;
    }
  });
}
