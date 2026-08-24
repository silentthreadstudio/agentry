// ProjectSwitcher — which workspace am I in, and how do I get to another one.
//
// This was a native `<select>`, which was wrong twice over. Visually it is an OS control dropped into a
// designed shell. But the real problem is informational: two projects can share a basename (two
// checkouts, a `web` inside two monorepos), and a select shows only the name — so the one thing you need
// to tell them apart, the path, is exactly what it hides.
//
// So: a popover that shows name AND path, marks the current one, and is fully keyboard-driven. It sits
// at the top of the sidebar because "which workspace am I in" is the first question you ask, and an
// answer buried at the bottom reads as a status readout rather than a control.
import { useEffect, useRef, useState } from "react";
import { fetchProjects, selectProject, type ProjectEntry } from "../../api/index.js";

export function ProjectSwitcher({ current }: { current: string | undefined }) {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchProjects(ctrl.signal)
      .then((list) => setProjects(list.projects))
      .catch(() => setProjects([]));
    return () => ctrl.abort();
  }, []);

  // Opening lands the cursor on the CURRENT project, so ↑/↓ moves relative to where you are rather than
  // from the top of a list you did not choose.
  useEffect(() => {
    if (!open) return;
    setCursor(Math.max(0, projects.findIndex((p) => p.slug === current)));
  }, [open, projects, current]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Switching is a full page load on purpose: every open view holds per-project state (the board, the
  // pane, the conversation, the socket), and reloading drops all of it at once rather than teaching each
  // view to re-key itself for an action taken a few times a day.
  const choose = (slug: string) => {
    if (slug === current) return setOpen(false);
    selectProject(slug);
    window.location.assign("/");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") return setOpen(false);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(projects.length - 1, c + 1));
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const pick = projects[cursor];
      if (pick) choose(pick.slug);
    }
  };

  const only = projects.length <= 1;

  return (
    <div className="projsel-wrap" ref={root}>
      <button
        type="button"
        className={`projsel${open ? " open" : ""}`}
        onClick={() => !only && setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        aria-haspopup={only ? undefined : "listbox"}
        aria-expanded={only ? undefined : open}
        aria-label={only ? `Project ${current ?? ""}` : `Project ${current ?? ""} — switch project`}
        // With one project there is nothing to switch to, so the control stops pretending to be one.
        disabled={only}
      >
        <span className="sq" aria-hidden="true">
          {(current ?? "??").slice(0, 2).toUpperCase()}
        </span>
        <span className="nm">{current ?? "workspace"}</span>
        <span className="livedot" title="server live" aria-label="server live" />
        {only ? null : (
          <span className="cv" aria-hidden="true">
            ▾
          </span>
        )}
      </button>

      {open ? (
        <div className="projpop" role="listbox" aria-label="Projects" onKeyDown={onKeyDown}>
          {projects.map((p, i) => (
            <button
              type="button"
              key={p.slug}
              role="option"
              aria-selected={p.slug === current}
              className={`projopt${i === cursor ? " cursor" : ""}${p.slug === current ? " on" : ""}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => choose(p.slug)}
            >
              <span className="sq" aria-hidden="true">
                {p.slug.slice(0, 2).toUpperCase()}
              </span>
              <span className="txt">
                <span className="n">{p.slug}</span>
                {/* The path is the point: two projects can share a name, and this is what tells them
                    apart. Truncated from the LEFT so the distinguishing tail stays visible. */}
                <span className="p" title={p.root}>
                  {p.root}
                </span>
              </span>
              {p.slug === current ? (
                <span className="tick" aria-hidden="true">
                  ✓
                </span>
              ) : null}
            </button>
          ))}
          <div className="projfoot">
            Run <code>/agentry:workbench</code> inside a repo to add it here.
          </div>
        </div>
      ) : null}
    </div>
  );
}
