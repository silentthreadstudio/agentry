// Two-root resolution: global `~/.agentry/memory` + optional project `.agentry/memory`.
//
// The project dir is the env's when it names one (CLAUDE_PROJECT_DIR, then AGENTRY_PROJECT_DIR), as the MCP
// server had it from Claude Code. A session's Bash commands get neither, so with a `cwd` the project dir is
// the main checkout of the git repo it is in: a call from a lane worktree reaches the same
// store the main checkout does. Outside any git repo there is no project root.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const storeOf = (dir) => join(dir, ".agentry", "memory");

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** The main checkout of the git repo `cwd` is in (a worktree's too), or null outside one. */
export function mainCheckoutOf(cwd) {
  try {
    const common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
    // `<main>/.git` for a checkout and its worktrees; a submodule's lives under the superproject's
    // `.git/modules/`, so its own top level is the checkout.
    return basename(common) === ".git" ? dirname(common) : git(cwd, "rev-parse", "--show-toplevel");
  } catch {
    return null;
  }
}

/** { global, project } for a known project dir (or null): the global root from the env as below. */
export function rootsAt(projectDir, env = process.env) {
  const globalDir = env.AGENTRY_GLOBAL_DIR;
  return {
    global: globalDir ? storeOf(globalDir) : storeOf(homedir()),
    project: projectDir ? storeOf(projectDir) : null,
  };
}

/**
 * { global, project } — the memory dirs. AGENTRY_GLOBAL_DIR is a *base dir* (`.agentry/memory` is
 * appended), as CLAUDE_PROJECT_DIR / AGENTRY_PROJECT_DIR are; absent, the global root is the home
 * directory's. No project dir in the env and no `cwd` in a git repo = no project root.
 */
export function resolveRoots(env = process.env, cwd = null) {
  const projectDir =
    env.CLAUDE_PROJECT_DIR ?? env.AGENTRY_PROJECT_DIR ?? (cwd ? mainCheckoutOf(cwd) : null);
  return rootsAt(projectDir, env);
}

/** repo -> project (if present) else global; user/global -> global always. */
export const originForScope = (scope, roots) => (scope === "repo" && roots.project ? "p" : "g");

export const dirFor = (origin, roots) =>
  origin === "p" && roots.project ? roots.project : roots.global;
