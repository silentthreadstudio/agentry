// Two-root resolution (doc 07 §1): global `~/.agentry/memory` + optional project `.agentry/memory`.
import { homedir } from "node:os";
import { join } from "node:path";
import type { Scope } from "@agentry/core";
import type { Origin } from "../domain/id.js";

export interface Roots {
  global: string;
  project: string | null;
}

export function resolveRoots(env: NodeJS.ProcessEnv = process.env): Roots {
  const global = join(homedir(), ".agentry", "memory");
  const projectDir = env.CLAUDE_PROJECT_DIR ?? env.AGENTRY_PROJECT_DIR;
  return { global, project: projectDir ? join(projectDir, ".agentry", "memory") : null };
}

/** repo → project (if present) else global; user/global → global always. */
export function originForScope(scope: Scope, roots: Roots): Origin {
  return scope === "repo" && roots.project ? "p" : "g";
}

export function dirFor(origin: Origin, roots: Roots): string {
  return origin === "p" && roots.project ? roots.project : roots.global;
}
