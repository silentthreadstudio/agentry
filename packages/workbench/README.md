# @agentry/workbench

The **Agent Center** — Agentry's local web app for *interacting with* a run's work: read/edit/comment/approve the
artifacts, and watch/steer the agents. Client #2 (chat is client #1); the `.agentry/` files are truth.

**Status:** empty scaffold. The full design + build brief is in **[VISION.md](./VISION.md)**; the design of record
is `.docs/internal/10-the-workbench.md`. Working visual/interaction prototypes live in **`design/`**.

Stack (decided): React 18 + Vite + TypeScript · React Flow + Dagre · Tiptap · a Node file-watching local service.
Built → committed dist at `plugin/workbench/` (dist-lockstep), launched by `/agentry:workbench`.

```
web/      the React app (UI)
server/   the local service (file-watch + websocket + write-endpoints)
design/   working prototypes — the visual + interaction target
```
