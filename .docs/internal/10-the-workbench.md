# 08 — The Workbench

> **Status:** Locked (iteration 1) · **Date:** 2026-06-13 · **Scope:** the review/edit surface — how a
> human reads, edits, comments on, and approves Agentry's artifacts, and how the experience of "agents
> working" surfaces. **The Workbench ships in V2.** This doc is signed *now* to lock the **V1 seams** it
> depends on, so V2 is "render + edit what already exists," not a rewrite (the v1 lesson).

---

## 0. Stance

> Design the Workbench now to lock the seams; build it in V2. **The chat session is client #1; the
> Workbench is client #2.** Neither owns truth — the artifact files do. If V1 produces clean artifacts,
> an honest event log, and an explicit state/lock model, V2 is additive.

The architecture decision: **files are the source of truth; a thin local service is a live transport +
lock layer *over* the files** (V2). Kill the service and the files still hold everything.

---

## 1. Read

The Workbench renders the `.agentry/` tree (01 §6): the work artifacts (spec · research · plan · tasks ·
reviews · journal) and the read-only memory view. It is a viewer over the folder — no separate datastore.

- **Artifacts** → rendered markdown, editable (§2).
- **Memory** → **read-only** (agent-curated only, 02). The Workbench is the memory viewer that makes the
  Obsidian wiki unnecessary.

---

## 2. Edit

Artifacts are **markdown = truth**, so they edit directly:
- The human edit is **authoritative**; the agent reads it back on its next turn.
- **Optimistic concurrency:** each artifact carries a content-hash/version; a save with a stale hash is
  **rejected** (not silently overwritten) so an edit can't clobber an agent's concurrent write.

Memory is never edited here — curate it through agent flows (02/03), not raw text.

---

## 3. Lock — "don't edit what an agent already started"

Driven by **one field**: the task's `status` (doc-01 task frontmatter).

- `status: in-progress` → the file renders **read-only** in the UI; `lockedBy` names the agent.
- `status: todo | in-review | done` → editable.

The lock is *state*, not a separate mechanism — the Workbench reads `status` and decides editability. The
thin service (V2) enforces it on the write endpoint.

---

## 4. Comments / review — the gate loop

The differentiated job (the plannotator-style loop), applied to **all** artifacts:

1. Select a span in an artifact → **comment** + a decision (`approve` / `request-changes`).
2. Persist to a **sidecar**: `<work>/.review/<gate>.annotations.json`.
3. **Anchor three ways** so a comment survives edits: `originalText` (quoted) + `headingAnchor` +
   `startLine`.
4. **The next chat turn is the sync point / gate**: the conductor reads the sidecar, resolves each
   comment, and revises. No live channel required for the basic loop.

```jsonc
// .review/<gate>.annotations.json
{ "gate": "plan", "comments": [
  { "id": "c1", "decision": "request-changes",
    "anchor": { "originalText": "…", "headingAnchor": "architecture-map", "startLine": 42 },
    "body": "Split this module — two responsibilities." } ] }
```

Deferred to later V2: inline editing-as-review (vs comment), diff review, threaded discussion.

---

## 5. "See agents working" — live, mostly native

Lean on Claude Code's native surfaces (the doc-04 §7 parked leads) before hand-rolling:

- **`/workflows` progress view** — phase/agent/token/elapsed for fan-out work.
- **agent-view state files** (`~/.claude/jobs/<id>/state.json`) — per-session state (working/blocked/done).
- **channels' permission-relay** — forward an approval prompt to the Workbench; reply `yes/no <id>` async
  (remote gating without an in-session prompt).
- **Event log** — an append-only JSONL the conductor/agents emit to (`agent started · on node X · spent N
  · done`); the Workbench tails it. This is the one piece we own; the rest is native.

The thin local service (V2) watches the files + tails the event log + serves a websocket to the browser +
exposes the review-sidecar write endpoint with the lock check.

---

## 6. The V1 seams (provide these now, so V2 is additive)

| Seam | Where | Status |
| :--- | :--- | :--- |
| Artifact folder schema | `.agentry/` (01 §6) | ✅ specified |
| Task `status` / `lockedBy` field | task frontmatter (01) | ✅ specified — confirm `lockedBy` is written |
| **Append-only event log** | `.agentry/…/events.jsonl` | ⬜ **add to V1** — conductor/agents emit |
| **Review sidecar protocol** | `.review/<gate>.annotations.json` + 3-way anchor | ⬜ **define in V1** (above) |
| Content-hash/version on artifacts | artifact frontmatter | ⬜ **add to V1** (optimistic concurrency) |

V1 owns these four data contracts. V2 builds the renderer, the editor, the review UI, and the thin
service on top — no rewrite.

---

## 7. Open / deferred

- **V2 build:** the React canvas/board (artifacts + relation edges + live status), the review UI, the
  thin local service (watch + websocket + lock-enforcing write endpoint).
- **Decisions to confirm at V2:** exact event-log schema · whether live updates use the local service or
  poll the native surfaces · canvas layout (board vs document list — keep it clean; a bad graph is worse
  than a clean list, the v1 lesson).
- **Browser MCP** for the designer's see-it loop is orthogonal (05) and already capability-first.

---

## 8. Closed vs deferred

**Closed:** the stance (files = truth, chat = client #1 / Workbench = client #2) · read (render `.agentry/`
+ read-only memory) · edit (markdown-truth + optimistic concurrency) · lock (`status`-driven) · the
review/gate loop (sidecar + 3-way anchor + chat-turn sync) · "see agents working" via native surfaces +
event log · **the four V1 seams** to provide now.

**Deferred:** the V2 build itself (UI + thin service) · inline-edit-as-review · diff review · the
event-log schema detail.

---

_Signed-off (iteration 1): the Workbench is designed and its V1 seams are locked. V1 provides the four
data contracts (artifacts, status/lock, event log, review sidecar); V2 renders and edits over them._
