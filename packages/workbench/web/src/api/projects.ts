// GET/POST /api/projects — which project roots this server serves, and joining a new one.
//
// The Workbench holds one globally-singleton port but serves many project roots (see the server's
// registry): this is how the sidebar switcher learns what is available, so the UI never has to guess or
// hardcode which repo it is looking at.
import { getJson } from "./http.js";

export interface ProjectEntry {
  /** The URL-facing name used as `?project=<slug>`. */
  slug: string;
  /** The absolute root the server reads `.agentry/` from — shown so two same-named repos are tellable. */
  root: string;
}

export interface ProjectList {
  projects: ProjectEntry[];
  /** The slug served when a request names no project (the root the server was started from). */
  default?: string;
}

export async function fetchProjects(signal?: AbortSignal): Promise<ProjectList> {
  return getJson<ProjectList>("/api/projects", signal);
}
