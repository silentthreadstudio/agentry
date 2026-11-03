// episodes — whether the memory store holds an episode, read from its files as the memory server
// writes them (`<root>/episodes/<slug>-<ulid>.md`, the id `p:<ulid>` or `g:<ulid>`). `lane exec close
// --episode` asks it, so a stamped id that names no episode is said, not trusted.
//
// episodeStored(projectDir, id) -> boolean
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { memoryRoots } from "./recall.mjs";

const bare = (id) => (id.includes(":") ? id.slice(id.indexOf(":") + 1) : id);

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
