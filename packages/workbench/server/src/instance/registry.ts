// registry — the set of project roots this Workbench serves.
//
// The port `:4317` is a global singleton but the project root used to be fixed at spawn, so the FIRST
// repo to start the server owned it: every later `/agentry:workbench` probed `/healthz`, saw `ok`, and
// "focused" someone else's project — silently, under the wrong label. One server now serves MANY
// projects and the client picks one (`?project=<slug>`), which is why this list has to outlive the
// process that started it.
//
// Truth is a small JSON file at `~/.agentry/workbench/projects.json` (user-global, not per-repo — the
// whole point is that it spans repos):
//
//   { "projects": [{ "root": "/abs/path", "addedAt": "<iso8601>" }] }
//
// A root is only servable once it has been REGISTERED — by starting the server there, or by the
// `/agentry:workbench` command POSTing it. That is the guardrail: a request cannot name an arbitrary
// filesystem path and have the server read it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface RegisteredProject {
  root: string;
  addedAt: string;
}

export function registryPath(): string {
  return join(homedir(), ".agentry", "workbench", "projects.json");
}

/** Every registered root, oldest first. A missing/corrupt file is an empty registry, never a throw —
 *  the server must still start (and re-register its own root) on a fresh machine. */
export function readRegistry(): RegisteredProject[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(registryPath(), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return [];
    const list = (parsed as { projects?: unknown }).projects;
    if (!Array.isArray(list)) return [];
    return list.filter(
      (p): p is RegisteredProject =>
        typeof p === "object" && p !== null && typeof (p as RegisteredProject).root === "string",
    );
  } catch {
    return [];
  }
}

/** Add a root (idempotent — an already-registered root keeps its original `addedAt`). Returns the full
 *  list. Written tmp-then-rename so a concurrent reader never sees a partial file (the pidfile pattern). */
export function registerRoot(root: string, now: string): RegisteredProject[] {
  const abs = resolve(root);
  const current = readRegistry();
  if (current.some((p) => p.root === abs)) return current;
  const next = [...current, { root: abs, addedAt: now }];
  const target = registryPath();
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ projects: next }, null, 2));
  renameSync(tmp, target);
  return next;
}
