import { resolve } from "node:path";
import { resolveSlug } from "@agentry/workbench-shared";
import { type Project, createProject, slugsFor } from "./application/project.js";
import type { Clock, RunChange } from "./domain/ports.js";
import { removePidfile, writePidfile } from "./instance/pidfile.js";
// Composition root for the Agentry Workbench local service — ADR-001's `index.ts` wiring.
//
// The lifecycle: acquire the singleton port-lock (ADR-002); if another instance already holds it, print
// that and exit 0 (a second invocation must NEVER spawn a second server — AC1). If we got the lock, write
// the advisory pidfile, build a tree per served project, attach the http handler + the ws transport to the
// bound server, wire each project's watchers → the ws push loop (the live half of AC7), and start. On
// SIGINT/SIGTERM, remove the pidfile and close every watcher cleanly.
//
// MULTI-PROJECT (M1). The root used to be fixed at spawn — `CLAUDE_PROJECT_DIR ?? AGENTRY_PROJECT_DIR ??
// cwd` — which, combined with a globally-singleton port, meant the FIRST repo to start the server owned
// it: `/agentry:workbench` in a second repo probed `/healthz`, saw `ok`, and focused a server showing
// someone else's runs under the wrong project name. Now the server serves every root in the registry
// (`~/.agentry/workbench/projects.json`), the startup root is registered and becomes the default, and a
// request names its project with `?project=<slug>`. A new repo JOINS the running server by POSTing
// `/api/projects` instead of losing the race.
import { bindPortLock } from "./instance/port-lock.js";
import { readRegistry, registerRoot } from "./instance/registry.js";
import { createHttpHandler } from "./transport/http.js";
import { type ProjectSource, runKey } from "./transport/projects.js";
import { WsTransport } from "./transport/ws.js";

// The root this server was STARTED from — the default project when a request names none. Resolved
// exactly as FLOW resolves its root (packages/flow/src/index.ts) so both layers see the same `.agentry/`.
function resolveStartupRoot(): string {
  return resolve(
    process.env.CLAUDE_PROJECT_DIR ?? process.env.AGENTRY_PROJECT_DIR ?? process.cwd(),
  );
}

// The single source of "now" injected into the application layer (the read-models' `updatedAt`).
const systemClock: Clock = { now: () => new Date().toISOString() };

async function main(): Promise<void> {
  const startupRoot = resolveStartupRoot();

  const lock = await bindPortLock();
  if (lock.status === "already-up") {
    // Another instance holds the port-lock — focus it, don't spawn a second (ADR-002, AC1). It serves
    // this root too as soon as the command registers it (POST /api/projects).
    console.log(
      "workbench already running on http://127.0.0.1:4317 — focusing the existing instance",
    );
    process.exit(0);
  }

  const server = lock.server;
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 4317;

  // Advisory metadata for the /agentry:workbench command (liveness + deep-link). The bind is the lock;
  // this file is just who/where/when.
  writePidfile(startupRoot, { pid: process.pid, port, startedAt: systemClock.now() });

  // ── the served projects ───────────────────────────────────────────────────────────────────────────
  // The startup root is registered (so a fresh machine works) and always sorts FIRST: it is the default
  // project, the one a request that names none gets. Every other registered root is served alongside it.
  registerRoot(startupRoot, systemClock.now());
  const byRoot = new Map<string, Project>();
  const bySlug = new Map<string, Project>();

  function rebuild(roots: string[]): void {
    const ordered = [startupRoot, ...roots.filter((r) => r !== startupRoot)];
    const slugs = slugsFor(ordered);
    for (const root of ordered) {
      const slug = slugs.get(root) ?? root;
      const existing = byRoot.get(root);
      if (existing) {
        // Keep the live tree (its watchers are already wired); only re-slug if a collision appeared.
        bySlug.delete(existing.slug);
        const reslugged: Project = { ...existing, slug };
        byRoot.set(root, reslugged);
        bySlug.set(slug, reslugged);
        continue;
      }
      const project = createProject(root, slug, systemClock);
      byRoot.set(root, project);
      bySlug.set(slug, project);
      wireLive(project);
    }
  }

  // The ws transport must exist before a project's watchers can push, but the resolver it needs closes
  // over the project map — so it is constructed first and the map is captured by reference.
  const transport = new WsTransport(server, (label, projectSlug) => {
    const project =
      projectSlug !== null ? bySlug.get(projectSlug) : bySlug.get(orderedSlugs()[0] ?? "");
    if (!project) return null;
    const run = resolveSlug(label, project.reader.listRuns());
    return run !== undefined ? runKey(project.slug, run) : null;
  });

  const orderedSlugs = (): string[] => [...bySlug.keys()];

  // A project's live loops: run-tree changes → per-run pushes (+ a payload-free nudge so a Works list
  // goes live for BRAND-NEW runs), and permission requests → a project-global broadcast.
  function wireLive(project: Project): void {
    project.watcher.subscribe((change: RunChange) => {
      transport.pushAll({ type: "works-changed" });
      if (!project.reader.read(change.run)) return; // run no longer resolves — nothing run-scoped to push
      for (const path of change.paths) {
        transport.push(runKey(project.slug, change.run), { type: "file-changed", path });
      }
    });
    project.permissionWatcher.subscribe((event) => {
      if (event.kind === "added") {
        transport.pushAll({ type: "permission-added", request: event.request });
      } else {
        transport.pushAll({ type: "permission-removed", requestId: event.requestId });
      }
    });
  }

  rebuild(readRegistry().map((p) => p.root));

  const projects: ProjectSource = {
    list: () => [...bySlug.values()],
    resolve: (slug) =>
      slug === null || slug.length === 0 ? byRoot.get(startupRoot) : bySlug.get(slug),
    register: (root) => {
      const abs = resolve(root);
      const existing = byRoot.get(abs);
      if (existing) return existing;
      rebuild(registerRoot(abs, systemClock.now()).map((p) => p.root));
      const added = byRoot.get(abs);
      if (!added) throw new Error(`failed to register project root: ${abs}`);
      // A newly-joined project changes the switcher's list for every open client.
      transport.pushAll({ type: "works-changed" });
      return added;
    },
  };

  server.on("request", createHttpHandler(projects, transport));

  console.log(
    `workbench server listening on http://127.0.0.1:${port} — serving ${bySlug.size} project(s): ${orderedSlugs().join(", ")} (default: ${startupRoot})`,
  );

  // Graceful shutdown: drop the pidfile, stop every watcher + ws, close the server.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`workbench server shutting down (${signal})`);
    removePidfile(startupRoot);
    transport.close();
    const closing = [...byRoot.values()].flatMap((p) => [
      p.watcher.close(),
      p.permissionWatcher.close(),
    ]);
    void Promise.allSettled(closing).finally(() => server.close(() => process.exit(0)));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("workbench server failed to start:", err);
  process.exit(1);
});
