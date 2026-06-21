---
title: "web shell: router + sidebar + design-system primitives + api/ws client +
  Works home"
status: done
lockedBy: implementer
assignee: implementer
version: e5198aee3aefd3b8
---

---
phase: 1
kind: feature
status: todo
deps: [1, 4]
parallel_safe_with: [6, 7, 8, 9]
---

## Goal
Build the React app shell: the router (sidebar + work-level tabs, prototype-app structure), the design-system primitives (the prototype's dark near-monochrome language), the typed api + ws clients, and the **Works home** page listing real runs that opens one to `<id>.localhost`. (AC2.)

## Contract
- **owns:** `packages/workbench/web/src/main.tsx` + `App.tsx` (promote the Phase-0 placeholder to the real router shell), `packages/workbench/web/src/api/client.ts`, `packages/workbench/web/src/api/ws-client.ts`, `packages/workbench/web/src/design-system/**` (`tokens.css`, `StatusDot.tsx`, `Pill.tsx`, `Card.tsx`, `Avatar.tsx`, `Button.tsx`, `SearchInput.tsx`, `EmptyState.tsx`), `packages/workbench/web/src/routes/Works.tsx`, and the empty `WorkLayout.tsx` shell (Live/Activity tab scaffold only)
- **exposes:** the design-system primitives (Phase 2/3/4 routes consume them — pin component names), the `api/client.ts` typed fetch wrappers + `ws-client.ts` subscription (consumed by every page), the router with named route slots Phase 2/4 fill (`Panorama`, `Activity`, the secondary pages). Types come from the `shared` pkg (task 1).
- **must NOT touch:** `server/**`, `routes/work/live/**` internals (Phase 2 owns Panorama/graph), `routes/work/.../doc/**` (Phase 3), the secondary page bodies `Agents/Tokens/Memory/Gates` (Phase 4) — leave route placeholders, don't implement them.

## Approach
- **Design is a constraint** (plan §1): match `design/prototype-app.html` — dark near-monochrome, the sidebar + work-tab structure. This task routes through the `designer` see-it loop (no UI ships unseen, VISION §11) — render the Works home + shell and verify the rendered pixels against the prototype.
- `api/client.ts` is typed by `shared` (task 1); `ws-client.ts` subscribes and updates a store with no reload (the AC7 mechanism on the web side). Consume the **pinned** endpoint paths from task 9 (`/api/works`, `/api/work/:id/graph`, `/api/context`) — if task 9 isn't merged yet, code to the pinned paths and verify after the wave (same-package caveat, recalled).
- Vite deps for this phase only: react-router (or the repo's choice). Heavy deps (`@xyflow/react`, Tiptap) are added by Phase 2/3 tasks.
- Empty states are good states (VISION §3): the Works home and the empty Live/Activity tabs render calm placeholders.

## Acceptance
- Works home lists every `.agentry/work/*` run with status/shape/agents (from `/api/works`); clicking a run navigates to `<id>.localhost:4317` showing an (empty) Live + Activity.
- Design-system primitives render in the prototype's visual language; the designer see-it loop confirms it against `prototype-app.html`.
- Closes the web side of AC2. Verifier loads the app and opens a work.
