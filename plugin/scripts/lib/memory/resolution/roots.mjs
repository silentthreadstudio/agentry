// Two-root resolution: global `~/.agentry/memory` + optional project `.agentry/memory`.
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * { global, project } — the memory dirs. AGENTRY_GLOBAL_DIR is a *base dir* (`.agentry/memory` is
 * appended), as CLAUDE_PROJECT_DIR / AGENTRY_PROJECT_DIR are; absent, the global root is the home
 * directory's. No project dir in the env = no project root.
 */
export function resolveRoots(env = process.env) {
  const globalDir = env.AGENTRY_GLOBAL_DIR;
  const global = globalDir
    ? join(globalDir, ".agentry", "memory")
    : join(homedir(), ".agentry", "memory");
  const projectDir = env.CLAUDE_PROJECT_DIR ?? env.AGENTRY_PROJECT_DIR;
  return { global, project: projectDir ? join(projectDir, ".agentry", "memory") : null };
}

/** repo -> project (if present) else global; user/global -> global always. */
export const originForScope = (scope, roots) => (scope === "repo" && roots.project ? "p" : "g");

export const dirFor = (origin, roots) =>
  origin === "p" && roots.project ? roots.project : roots.global;
