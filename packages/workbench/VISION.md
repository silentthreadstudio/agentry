# `@agentry/workbench` — VISION

> The build brief for the **Agentry Workbench** — the local **Agent Center**. This is the *what & why* and the
> acceptance bar; the design (doc `.docs/internal/10-the-workbench.md`) and two working prototypes in `design/`
> are the visual + interaction target. Dispatch this through `/agentry:go`.

---

## 1. North star

A per-project desktop-grade web app where a human **interacts with Agentry's work** — reads, edits, comments on,
and approves the artifacts a run produces, and watches/steers the agents as they execute. **Client #2** (chat is
client #1); **the `.agentry/` files are truth** — the Workbench is a live transport + lock layer over them, never
a second datastore. It is an *Agent Center you act in*, not a dashboard you watch.

It renders the seams **FLOW MCP v1 already produces** (`task_status`/`lockedBy`, `events.jsonl`, the `.review/`
sidecar, the `version` content-hash). No new data contracts — read, render, and write back through the same files.

---

## 2. Stack (decided — do not re-litigate)

| Part | Choice |
| :-- | :-- |
| UI | **React 18 + Vite + TypeScript** |
| Canvas | **React Flow** (`@xyflow/react`) |
| Graph layout | **Dagre** (`@dagrejs/dagre`) now → **ELK** (`elkjs`) when orthogonal routing is needed |
| Documents | **Tiptap** (ProseMirror, MIT core; custom comment marks; **no Tiptap Pro / no Yjs** in V1) |
| Server | **Node + TypeScript** local service (file-watch + websocket + write-endpoints) |
| Theme | **dark-first**, near-monochrome, one restrained accent (toggle optional) |

Layout: `packages/workbench/web/` (the React app) + `packages/workbench/server/` (the local service). Build →
**committed dist** at `plugin/workbench/` (built UI + server bundle), **dist-lockstep** like `plugin/mem` /
`plugin/flow`; `check-plugin` extended to validate it.

---

## 3. Information architecture (the refined model)

**Two levels — because you can be working on several runs at once.**

**Project level (the sidebar, always present):**

| Page | One job |
| :-- | :-- |
| **Works** *(home / landing)* | every run/work in the project as cards — status · shape · kind · agents · last activity; filter + search. The landing. **Open one** to work on it. |
| **Agents** | the roster, live — each agent's state, runs touched, recent work; spot the bottleneck. |
| **Tokens** | usage + cost over time (per run / agent / day). Source: Claude Code session transcripts (the `session-report` source). |
| **Memory** | the moat, **read-only** — browse/search facts + episodes + recall activity. The Obsidian replacement. Never an editor. |
| **Gates** | the **inbox** — every gate across works *waiting on you* (approve / answer) → jump to the doc at the gate. |

**Work level (open a work → `/work/<id>`):** a work-detail view with its own tabs —

- **Live** — the run as a **React Flow document-graph** (§4) + the document drawer/editor + comments (§5). The
  default tab; auto-focuses the active node.
- **Activity** — *this work's* event timeline (routing → gates → node-enter/done + durations · agent states).
- *(later)* **Documents** / **Reviews** indexes.

There is **no global "Live"** — live is a property *of a work you've opened*. Home is the Works list.

Design law for every secondary surface: **dark, near-monochrome, status = a small dot + muted label, whitespace
over borders, no icon noise.** They inform; they never compete with the work. A shared **event store** (the
server aggregates every run's `events.jsonl` + the hooks + token usage into a queryable per-project timeline)
powers Activity / Agents / Tokens / Gates.

---

## 4. The panorama — the run as a document-graph (React Flow)

Artifacts are nodes (`routing → spec → ADRs → plan → tasks`), real relationships are edges. Render the structure
that already exists; make it alive.

- **No overlap / no lines over nodes.** Build nodes+edges → **Dagre** computes positions (rank + crossing-min +
  `ranksep`/`nodesep` spacing) → React Flow renders → `fitView`; re-run on change. `smoothstep` edges with
  bottom-source / top-target handles. **Upgrade to ELK** (`layered` + orthogonal routing → waypoints → custom
  edge) when straight edges clip nodes.
- **Typed edges — one visual per relationship** (custom `edgeTypes` + a legend): `derives` / `depends-on` (solid,
  neutral, arrow) · **`blocks` (dashed · accent-red · animated · label)** · `satisfies` task→AC (dotted, faint).
- **Density control:** dim edges by default; **highlight a node's edges on hover/select**.
- **Live execution on the graph:** nodes carry state (todo/in-progress/in-review/done/blocked) + the assigned
  agent + the version; in-progress pulses; a `blocks` edge glows when its blocker is active. Updates in real time.
- **Governance is drawn.** The **routing decision is the graph root** → the *shape of the graph IS the routing
  shape* (one-shot = one node · spec-first = spec only · decompose = the full DAG). **Gates are checkpoints**: a
  `request-changes` holds the downstream edges until you approve; you can **escalate the altitude** from the
  canvas. Process altitude is always visible and steerable — the "never uncontrolled" guarantee.

---

## 5. The document layer (Tiptap)

Click a node → it opens as a **document** (the same `.agentry/` markdown, rendered rich, in a drawer over the
dimmed graph).

- **Read/edit** — a calm Notion/Linear-grade editor. ADRs render as **structured decision cards** (Context /
  Decision / Alternatives / Consequences). **Markdown stays truth**: frontmatter is parsed out and edited as
  fields (status/version/deps), never round-tripped as prose; a raw **source-mode** (CodeMirror) toggle for power
  edits; **golden round-trip tests** guard the serializer.
- **Lock-aware** (task `status`): `in-progress` → read-only with `lockedBy` shown ("implementer is editing this
  now"); else editable. **Take over** grabs the lock; the server enforces it.
- **Comment on a span** — select → a bubble (format actions when editable · Comment / Approve / Request changes).
  The comment is a **ProseMirror mark** (anchor tracks edits natively) and is persisted to the `.review/` sidecar
  with the 3-way anchor (`originalText + headingAnchor + startLine`) so the *agent* can read + relocate it.

---

## 6. The comment loop — bidirectional (AI ↔ Dashboard)

**The file layer is the bus.** Both directions go through `.agentry/`; the websocket (and V2.1 channels) are live
transports over the files.

```
AI → Dashboard   agent writes .agentry/ (artifact · events · reply)
                 → server file-watch (chokidar) → websocket push → browser live-updates

Dashboard → AI   human comment / edit (Tiptap)
                 → server writes .review/<gate>.json (3-way anchor) or the artifact (version-checked)
                 → agent reads it ──┬─ ASYNC (V1): next gate via FLOW review_list()
                                    └─ LIVE  (V2.1): a channel push into the session (doc 13)
```

- **The diff / accept loop.** FLOW stamps a `version` hash on every write → a reply is a diff: the agent answers
  a comment by rewriting the artifact (new hash) + a sidecar reply → server pushes both → the dashboard renders
  **old-version vs new-version** with **Accept / Reject / Iterate**. Reject/Iterate writes a follow-up comment.
- **Safety = lock + optimistic concurrency:** editing under the agent's lock is read-only; a stale-version save is
  rejected (FLOW `artifact_write`) — the directions can't clobber.
- **Comment lifecycle:** `open → answered (+reply, +new version) → accepted | rejected | iterating`.

---

## 7. The local service

- **One instance per project**, fixed port (e.g. `:4317`), pidfile + port lock → *exactly one*.
- **Named-domain routing:** `*.localhost` auto-resolves to `127.0.0.1` (no `/etc/hosts`); the server **host-routes
  by run id** → each work gets its own URL (`flow-mcp-v1.localhost:4317`). Multiple works = multiple named tabs
  off one server.
- Responsibilities: **watch** `.agentry/` (chokidar) · **serve** the built UI · a **websocket** pushing file
  changes · **write-endpoints** for the review sidecar + artifact edits that enforce the **lock** (task `status`)
  and **optimistic concurrency** (the `version` hash). **Stateless over the files** — restart loses nothing.

---

## 8. Launch & packaging

- **`/agentry:workbench [work]`** (new command): resolve the project root → probe the port → **open/focus** the
  running instance (deep-linked to the work) or **start** it (committed `plugin/workbench/` bundle) → open the
  browser. Never spawns a second server.
- **Committed dist** at `plugin/workbench/` (built UI + server bundle); **dist-lockstep** + `check-plugin`
  extended to cover it (mirror the `bundleSrcHash` pattern). Reload-gated where the command/manifest registers.

---

## 9. Non-goals (deferred)

- **Channels / live-push** (the blocking plannotator + remote permission relay) → **V2.1** (doc 13). V1 ships the
  async file-watch + websocket loop.
- **Global (cross-project) scope** — the `Projects → Works` top level → later.
- **Yjs real-time co-editing / cursors** → V2.1+. **Time-travel replay** of a run → strong later feature, not V1.
- The Workbench never **edits memory** (agent-curated) and never becomes a **datastore** (files stay truth).

---

## 10. Acceptance criteria (observable)

1. `/agentry:workbench` opens a browser to the running per-project server; a second invocation **focuses the same
   instance** (never a second server).
2. **Works (home)** lists every run in `.agentry/work/` with status/shape/agents; opening one routes to
   `<id>.localhost:<port>` and shows that work's **Live + Activity**.
3. **Live** renders the run as a React Flow graph with **Dagre auto-layout (no overlapping nodes)** and **typed
   edges** (derives/depends/blocks/satisfies visually distinct + a legend); hover highlights a node's edges.
4. A node opens as a **Tiptap document**; an `in-progress` artifact is **read-only with `lockedBy`**; a
   `done`/`todo` one is editable; **Take over** flips the lock.
5. Selecting a span and commenting writes a **3-way-anchored entry to `.review/<gate>.json`**; it shows in the
   rail and badges the node.
6. An **edit saved with a stale `version` is rejected** (optimistic concurrency); a fresh edit writes the file +
   bumps the version.
7. An agent change to a watched file **live-updates the browser over the websocket** (no reload); a comment reply
   renders a **before/after diff** with Accept / Reject / Iterate.
8. **Activity / Agents / Tokens / Memory / Gates** each render from real data (event store · transcripts · `mem`
   store · `.review/`), dark and calm per the design language.
9. `pnpm --filter @agentry/workbench build` produces the committed `plugin/workbench/` dist; **`check-plugin` is
   green and validates the new bundle's dist-lockstep**.
10. Verified **live** (a real run, after the command launches it) — not just green in code.

---

## 11. Reference

- **`design/prototype-app.html`** — the working shell + React Flow + Dagre + typed edges + the pages (the visual
  target). **`design/prototype-document.html`** — the Tiptap document + comment + diff-accept loop (the
  interaction core). Both run in a browser as built (real React Flow / real Tiptap from CDN).
- **`.docs/internal/10-the-workbench.md`** — the design of record. **`.docs/internal/13-the-flow-mcp.md`** — the
  FLOW seams this renders over + the V2.1 channel layer.
- **The design language is a constraint** (dark, near-monochrome, clean — match the prototypes); the *component
  implementation* is the `designer`'s output via the see-it loop. No UI ships unseen.
