// projects — the project-selection seam: the source the http handler resolves `?project=<slug>` against,
// the composite ws key, and the `/api/projects` dispatcher (list + register).
//
// Why a registry at all: the port is a global singleton but the served root used to be fixed at spawn, so
// the first repo to start the Workbench owned it and every later `/agentry:workbench` silently focused
// that repo's server. One server serves many projects now; the client says which one it means.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Project } from "../application/project.js";
import { guardGet, readJsonBody, sendJson } from "./http-kit.js";

export interface ProjectSource {
  /** Every served project (the sidebar switcher's list), the default first. */
  list(): Project[];
  /** The project a request means: an explicit `?project=<slug>`, or the default when absent. An explicit
   *  slug that names nothing is `undefined` — a 404, never a silent fall-back to somebody else's repo. */
  resolve(slug: string | null): Project | undefined;
  /** Register (and start serving) a root at runtime. Idempotent; returns the resulting project. */
  register(root: string): Project;
}

/** The ws subscription key. Run ids are only unique WITHIN a project, so the key carries both — otherwise
 *  two projects with a run of the same name would cross-deliver each other's live updates. */
export function runKey(projectSlug: string, run: string): string {
  return `${projectSlug}::${run}`;
}

/**
 * `GET  /api/projects` → `{ projects: [{ slug, root }], default: <slug> }`
 * `POST /api/projects` `{ root }` → the registered project (idempotent)
 *
 * Project-independent by definition — it is how a client discovers which projects exist, so it must not
 * itself require one.
 */
export function handleProjectsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  projects: ProjectSource,
): boolean {
  if (url.pathname !== "/api/projects") return false;
  const method = req.method ?? "GET";

  if (method === "POST") {
    void readJsonBody(req).then((body) => {
      const root =
        typeof body === "object" && body !== null ? (body as { root?: unknown }).root : undefined;
      if (typeof root !== "string" || root.length === 0) {
        return sendJson(res, 400, { error: "root_required" });
      }
      const project = projects.register(root);
      sendJson(res, 200, { slug: project.slug, root: project.root });
    });
    return true;
  }

  return guardGet(method, res, () => {
    const list = projects.list();
    sendJson(res, 200, {
      projects: list.map((p) => ({ slug: p.slug, root: p.root })),
      default: list[0]?.slug,
    });
  });
}
