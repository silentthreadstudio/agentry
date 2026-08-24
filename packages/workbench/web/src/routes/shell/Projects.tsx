// Projects — every root this one server is serving.
//
// It exists because the port is a global singleton while the project root is not: without a list, the
// only way to know what else this server holds is to guess. Switching is a full page load on purpose —
// every open view holds per-project state (the board, a graph, an open doc, the socket) and reloading
// drops all of it at once rather than teaching each view to re-key itself.
import { useEffect, useState } from "react";
import { fetchProjects, selectProject, type ProjectEntry } from "../../api/index.js";
import { EmptyState } from "../../ui/index.js";

export function Projects({ current }: { current: string | undefined }) {
  const [projects, setProjects] = useState<ProjectEntry[] | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchProjects(ctrl.signal)
      .then((list) => setProjects(list.projects))
      .catch(() => setProjects([]));
    return () => ctrl.abort();
  }, []);

  if (projects === null) return <div aria-busy="true" />;
  if (projects.length === 0) {
    return <EmptyState title="No projects registered">Run /agentry:workbench in a repo to add it here.</EmptyState>;
  }

  return (
    <div className="blist">
      {projects.map((p) => (
        <article className={`brow${p.slug === current ? " on" : ""}`} key={p.slug}>
          <div className="main">
            <div className="ttl">{p.slug}</div>
            <div className="ctx mono">{p.root}</div>
          </div>
          {p.slug === current ? (
            <span className="chip">current</span>
          ) : (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                selectProject(p.slug);
                window.location.assign("/");
              }}
            >
              Open
            </button>
          )}
        </article>
      ))}
    </div>
  );
}
