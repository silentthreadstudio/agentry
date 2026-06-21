---
id: plan
title: "@agentry/workbench — the Agentry Agent Center V2 (Plan + architecture map)"
status: draft
date: 2026-06-19
author: architect
work: build-agentry-workbench-the-agentry-agent-center-5s9v6deiit
gate: plan
adrs:
  - 1
  - 2
  - 3
  - 4
  - 5
  - 6
satisfies_spec: VISION.md §10 AC1–AC10
note: >
  Plan + ADRs only. Task contracts are sliced in a later /agentry:split
  dispatch, AFTER this plan is approved at the plan gate. The phasing below is
  the input to that split, not the split itself.
version: 5c4441c2ffc653ee
---

# Plan — `@agentry/workbench`, the Agent Center V2

**Problem (one line).** Build a per-project, single-instance, named-domain React+Vite+Tiptap+React-Flow web app over a thin stateless Node file-watching service that renders, edits, comments-on, and approves the FLOW v1 `.agentry/work/*` seams — files stay truth — satisfying VISION §10 AC1–AC10, verified live.

This is a **large arc with many actors** (watch / host-route / lock-enforce / aggregate / graph / editor / diff / five pages / command / packaging). The floor is set by those actors, not by a file count — it earns full ports-and-adapters structure on the server and a layered component structure on the web. The single most important output is the **phasing** (§5): each phase is an independently verifiable, demoable increment, riskiest/foundational first.

adsasd

asdasdds

asdsad

---

## 1. Approach

- **Render over FLOW, never re-contract it.** Everything the UI shows comes from the exact on-disk shapes FLOW writes (mapped below in §3). The server reuses `@agentry/flow`'s `domain/` shapes + `computeVersion` (ADR-005), so the two writers are byte-compatible.
- **Server = stateless ports-and-adapters over the files** (ADR-001), mirroring `@agentry/memory`/`@agentry/flow` layering — the house style. Restart loses nothing.
- **One instance, OS-enforced** (ADR-002): the `:4317` port bind is the lock; a pidfile carries deep-link metadata; `*.localhost` host-routes by run id.
- **Two committed artifacts** (ADR-003): Vite → `plugin/workbench/web/`, esbuild → `plugin/workbench/server/`, each with its own `.srchash`, both validated by an extended `checkBundle()`. No shipped `node_modules`.
- **Markdown stays truth** (ADR-004): frontmatter split, one golden-tested serializer module, source-mode hatch.
- **Safety at one boundary** (ADR-006): lock + optimistic-concurrency enforced server-side at write time.
- **Design is a constraint, not a suggestion.** The two prototypes (`design/prototype-app.html`, `prototype-document.html`) are the visual + interaction target (the dark near-monochrome language, the typed-edge rendering, the comment/diff loop). Every UI-bearing phase routes through the `designer` see-it loop — no UI ships unseen (VISION §11).

---

## 2. Architecture map

### 2.1 Package & folder structure

```
packages/workbench/
├── package.json            # @agentry/workbench; build = vite build + server/build.mjs; deps: see ADR-003/005
├── shared/                 # the server↔web read-model contract (ADR-005 tier 2) — ONE owner
│   └── src/types.ts        # RunSummary · GraphModel{nodes,edges} · DocModel{frontmatter,body,version,lock}
│                           #   · GateItem · EventView · AgentView · TokenSeries · WsMessage (the ws envelope)
│
├── server/                 # the Node TS local service — ports-and-adapters (ADR-001)
│   ├── build.mjs           # esbuild → plugin/workbench/server/index.js (+ .srchash); mirrors memory/build.mjs
│   ├── src/
│   │   ├── domain/         # PURE, no I/O. The ports + the read-model assembly types.
│   │   │   ├── ports.ts    #   WorkRepository · Watcher · Transport · MemSource · TranscriptSource · Clock
│   │   │   └── graph.ts    #   buildGraph(run files) → GraphModel: nodes (routing/spec/adr/plan/task) +
│   │   │                   #     typed edges (derives/depends-on/blocks/satisfies) from frontmatter deps/satisfies
│   │   ├── application/     # orchestration over ports; pure of HTTP/ws
│   │   │   ├── work-reader.ts     # parse one run dir → { summary, graph, docs } (uses flow/domain shapes)
│   │   │   ├── event-store.ts     # fold every run's events.jsonl (+ hook lines via flow parseLogLine) →
│   │   │   │                      #   per-project timeline; powers Activity/Agents/Gates aggregation
│   │   │   ├── gate-inbox.ts      # scan every run's .review/*.annotations.json → open (waiting-on-you) items
│   │   │   ├── write-service.ts   # the TWO writes: review comment + artifact edit; enforces lock + version
│   │   │   │                      #   (ADR-006). The single safety boundary.
│   │   │   └── token-reader.ts    # Claude Code session transcripts → TokenSeries (per run/agent/day)
│   │   ├── persistence/     # fs/process adapters implementing the ports
│   │   │   ├── fs-work-repository.ts   # readdir/parse .agentry/work/* (FLOW frontmatter regex)
│   │   │   ├── chokidar-watcher.ts     # watch .agentry/ → debounced change events keyed by run
│   │   │   ├── mem-reader.ts           # READ-ONLY over the mem file-store (facts/episodes .md) — Memory page
│   │   │   ├── transcript-reader.ts    # locate + parse session transcripts (the session-report source)
│   │   │   └── flow-writer.ts          # the artifact/sidecar write adapter: replicates TaskFileStore render +
│   │   │                               #   computeVersion (shared flow shapes) — files-are-truth write path
│   │   ├── transport/
│   │   │   ├── http.ts          # serve plugin/workbench/web/ static + the /api REST surface
│   │   │   ├── ws.ts            # websocket: push WsMessage (file-changed/doc-updated/diff-ready) per run
│   │   │   ├── host-router.ts   # parse <id>.localhost Host label → run context (assertSafeSegment guard)
│   │   │   └── routes.ts        # /api/works · /api/work/:id/{graph,doc,review} · /api/{events,agents,tokens,
│   │   │                        #   memory,gates} · POST /api/work/:id/{comment,artifact,takeover} · /healthz
│   │   ├── instance/
│   │   │   ├── pidfile.ts       # .agentry/run/workbench.json read/write (atomic) + liveness probe (ADR-002)
│   │   │   └── port-lock.ts     # bind :4317 = the lock; EADDRINUSE ⇒ "already up" (ADR-002)
│   │   └── index.ts            # composition root: lock → wire adapters → start transports
│   └── test/                   # work-reader · graph-builder · write-service (lock+version) · event-store folds
│
├── web/                    # the React + Vite + TS app
│   ├── vite.config.ts      # base:'./'  · build → ../../plugin/workbench/web  · @xyflow/react css
│   ├── index.html
│   └── src/
│       ├── main.tsx · App.tsx        # router shell (sidebar + work-level tabs; prototype-app structure)
│       ├── api/                       # the client over the server read-models
│       │   ├── client.ts             # REST fetch wrappers (typed by shared/types)
│       │   └── ws-client.ts          # websocket subscription → live store updates (no reload; AC7)
│       ├── design-system/            # the SHARED primitives = the prototype's design language (ADR-?: tokens)
│       │   ├── tokens.css            # the prototype palette/spacing/type (dark near-monochrome)
│       │   ├── StatusDot.tsx · Pill.tsx · Card.tsx · Avatar.tsx · Button.tsx · SearchInput.tsx · EmptyState.tsx
│       ├── routes/
│       │   ├── Works.tsx             # home/landing: run cards (AC2)
│       │   ├── Agents.tsx · Tokens.tsx · Memory.tsx · Gates.tsx   # the calm secondary pages (AC8)
│       │   └── work/
│       │       ├── WorkLayout.tsx    # the work-detail shell + Live/Activity tabs
│       │       ├── Activity.tsx      # this work's event timeline
│       │       └── live/
│       │           ├── Panorama.tsx          # React Flow canvas (AC3)
│       │           ├── layout-dagre.ts       # build nodes/edges → Dagre → positions → fitView
│       │           ├── DocNode.tsx           # custom node (status/agent/version; pulse/dim/lit)
│       │           ├── edge-types.tsx        # typed edges + legend (derives/depends/blocks/satisfies)
│       │           └── doc/
│       │               ├── DocDrawer.tsx     # the Tiptap document over the dimmed graph (AC4)
│       │               ├── markdown-serializer.ts   # md↔Tiptap, golden-tested (ADR-004) — ONE owner
│       │               ├── CommentMark.ts           # the ProseMirror comment mark (anchor tracks edits)
│       │               ├── CommentRail.tsx · SelectionBubble.tsx   # comment UI (AC5)
│       │               ├── SourceMode.tsx           # CodeMirror raw-markdown toggle (ADR-004)
│       │               ├── LockBar.tsx · TakeOver.tsx              # lock-aware UI (AC4)
│       │               └── DiffDrawer.tsx           # before/after + Accept/Reject/Iterate (AC7)
│       └── test/                      # golden round-trip corpus (ADR-004); graph-from-frontmatter
│
plugin/workbench/        # COMMITTED dist (tracked, like plugin/mem · plugin/flow)
├── web/{index.html, assets/…} + web/.srchash
└── server/index.js + server/.srchash

plugin/commands/workbench.md   # the /agentry:workbench [work] command (ADR-002 flow)
```

**One concern per module** (the SRP bar): `host-router` only maps Host→run; `port-lock` only enforces singleton; `write-service` only enforces the two safety invariants; `markdown-serializer` is the *only* place markdown is parsed/emitted; `graph.ts` is the *only* place frontmatter becomes nodes/edges. No god-file.

### 2.2 Why these seams

- **`domain` imports nothing** → the graph builder and read-model assembly are unit-testable with plain data.
- **`write-service` is the lone write boundary** → the clobber-safety guarantee (ADR-006) lives in one testable place, not scattered across routes.
- **`markdown-serializer` + golden corpus** is one module → the round-trip risk is contained and guarded (ADR-004).
- **`event-store` aggregates across runs** → Activity/Agents/Tokens/Gates are projections of one fold, not five ad-hoc scanners (doc 10 §5).

---

## 3. The data contracts at the seams (the EXACT FLOW on-disk shapes)

Read these from the FLOW source (verified against `packages/flow/src`):

**Writes (the only two, ADR-006):**

1. **Review comment** → `WriteService` appends a `ReviewComment` (3-way anchor built from the Tiptap selection: `originalText` = selected span, `headingAnchor` = nearest `##`, `startLine` = body line) to `.review/<gate>.annotations.json`, validated through the `ReviewComment` shape. Allowed even when locked.
2. **Artifact edit** → recombine untouched frontmatter + re-serialized body (ADR-004), reject if `status===in-progress` (lock) or if `baseVersion` ≠ current `computeVersion` (stale, AC6), else write via `flow-writer` (re-stamps version) and push the new version over ws.

**The live loop (AC7):** agent writes a file → `chokidar-watcher` fires → `event-store`/`work-reader` re-projects → `ws` pushes a `WsMessage` keyed to the run → web store updates the node/doc/diff with no reload.

---

## 4. Build / dist pipeline & the command (AC9, AC1)

### 4.1 Two-artifact build + dist-lockstep (ADR-003)

- `pnpm --filter @agentry/workbench build` = `vite build` (→ `plugin/workbench/web/`, stamps `web/.srchash`) **then** `node server/build.mjs` (esbuild ESM + `createRequire` banner + `node:*` external → `plugin/workbench/server/index.js`, stamps `server/.srchash`). No `node_modules` shipped (Vite bundles UI deps into assets; esbuild bundles server deps into one file).
- `scripts/lib/src-hash.mjs`: **additive** `srcSubdir`/explicit-src support so `bundleSrcHash` can hash `web/src` (no workspace deps) and `server/src` (+ `@agentry/flow/src` transitively). Existing mem/flow callers unchanged.
- `scripts/check-plugin.mjs`: **two new `checkBundle()` calls** — `web` (sentinel `plugin/workbench/web/index.html`) and `server` (`plugin/workbench/server/index.js`) — yielding `dist-lockstep (web)` / `dist-lockstep (server)` rows. Standing rule: any `web/server/src` (or `@agentry/flow/src`) change ⇒ rebuild + commit the artifact + `.srchash` in the same change.

### 4.2 The `/agentry:workbench [work]` command (ADR-002, AC1)

`plugin/commands/workbench.md` (registers reload-gated): resolve project root → probe `http://127.0.0.1:4317/healthz`. **Up** ⇒ open `http://<work || >.localhost:4317` (focus, no spawn). **Down** ⇒ spawn `node ${CLAUDE_PLUGIN_ROOT}/workbench/server/index.js` detached, poll `/healthz` until ready, write the pidfile, open the deep link. The port bind is the singleton lock; a second invocation always lands on **Up**.

---

## 5. Phasing — six independently verifiable increments (riskiest/foundational first)

> Ordered by **dependency + risk**, not AC number. Each phase ends in a concrete demo. Phases 0–1 de-risk packaging and the file→read-model→ws spine (the foundation everything rides on) before any rich UI; the two hardest *interaction* surfaces (graph, then the doc/comment/diff/lock loop) come next; secondary pages and the command/live-verification close it out.

### Phase 0 — Scaffold + two-artifact build + dist-lockstep green (foundation, de-risks packaging)

- **ACs:** AC9 (partial — the pipeline + gate, on an empty app).
- **Tasks (rough):** real `package.json`/`tsconfig` for web+server+shared; minimal `vite build` of a placeholder React app → `plugin/workbench/web/`; minimal esbuild `server/build.mjs` of a `/healthz`-only server → `plugin/workbench/server/index.js`; the additive `bundleSrcHash` `srcSubdir` change; two `checkBundle()` calls in `check-plugin.mjs` (mem/flow callers regression-checked unchanged).
- **Demo:** `pnpm --filter @agentry/workbench build` produces both committed artifacts; `node scripts/check-plugin.mjs` is **green** with `dist-lockstep (web)` + `dist-lockstep (server)` rows; touching a `src` file flips them to "stale" until rebuilt. *Proves the riskiest non-UI unknown — the two-artifact lockstep — before a line of UI.*

### Phase 1 — The server spine + Works home + open-a-work (the file→read-model→ws core)

- **ACs:** AC1 (focus-or-start + single instance), AC2 (Works lists real runs; open routes to `<id>.localhost`).
- **Tasks:** `port-lock` + `pidfile` (singleton); `host-router`; `fs-work-repository` + `work-reader` (parse run dirs → `RunSummary`/`GraphModel` minimal); `chokidar-watcher` + `ws` push; `http` static-serve + `/api/works`
    - `/api/work/:id/graph`; the `web` shell (sidebar + Works route + work-level tab scaffold + ws-client); the **`/agentry:workbench` command**.
- **Demo:** command opens the browser to the running server; a second invocation focuses (no second process — AC1); Works lists every `.agentry/work/*` run with status/shape/agents; opening one routes to `<id>.localhost:4317` and shows an (empty) Live + Activity. *The whole transport spine, demoable.*

### Phase 2 — The panorama (React Flow document-graph)

- **ACs:** AC3 (Dagre no-overlap + typed edges + legend + hover-highlight), and the live-execution overlay on the graph (node state/agent/version; in-progress pulse; blocks-edge glow) from the ws stream.
- **Tasks:** `graph.ts` (frontmatter `deps`/`satisfies` → typed edges; routing decision = root, so graph shape = routing shape, VISION §4); `layout-dagre.ts`; `DocNode.tsx`; `edge-types.tsx` + legend; wire the ws live updates onto nodes/edges. Design see-it loop against `prototype-app.html`.
- **Demo:** open a real decompose+verify run → the full DAG renders with no overlapping nodes, the four edge types visually distinct + a legend, hover highlights a node's edges; a live `node-enter`/status change re-renders the node without reload.

### Phase 3 — The document layer: Tiptap + comment + lock + version + diff loop (the interaction core)

- **ACs:** AC4 (node→Tiptap doc; in-progress read-only + lockedBy; todo/done editable; Take over flips the lock), AC5 (span comment → 3-way-anchored `.review/<gate>.json` + rail + node badge), AC6 (stale-version save rejected; fresh edit writes + bumps version), AC7 (live ws update + before/after diff with Accept/Reject/Iterate).
- **Tasks:** `markdown-serializer` + **golden round-trip corpus** (ADR-004, the tripwire — build this first in the phase); `CommentMark`; `DocDrawer` + `LockBar`/`TakeOver`; `CommentRail` + `SelectionBubble`; `SourceMode`; `write-service` (lock + optimistic concurrency, ADR-006) + `flow-writer`; `DiffDrawer`; the POST endpoints (`/comment`, `/artifact`, `/takeover`). Design see-it loop against `prototype-document.html`.
- **Demo:** click a node → it opens as a rich doc; an `in-progress` one is read-only showing `lockedBy`, Take over flips it; select a span → comment → a 3-way-anchored entry lands in `.review/<gate>.annotations.json` and badges the node; a save with a stale version is **rejected**; an agent edit live-updates the doc and a comment reply renders the before/after diff with Accept/Reject/Iterate. *This is the heart — the most interaction risk.*

### Phase 4 — The secondary pages (calm observability)

- **ACs:** AC8 (Activity · Agents · Tokens · Memory · Gates each from real data, dark/calm).
- **Tasks:** `event-store` fold → Activity (per-work) + Agents (roster across runs); `gate-inbox` → Gates inbox (jump-to-doc-at-gate); `token-reader` over transcripts → Tokens charts; `mem-reader` (read-only) → Memory browse/search. Each a route + its read-model endpoint. Design see-it loop (the calm design law, VISION §3).
- **Demo:** all five pages render from real `events.jsonl` / `.review/` / `mem` store / transcripts; Gates is the waiting-on-you inbox; Memory is read-only search; empty states are good states.

### Phase 5 — End-to-end live verification + polish (AC10, the "never green-only" gate)

- **ACs:** AC10 (verified live — a real run, after the command launches it), AC9 (final — full lockstep green at commit), and the cross-cutting design/a11y polish pass.
- **Tasks:** drive the full loop live after a **plugin reload/restart** (recalled reload-gated rule): start a real run, launch via the command, exercise graph→doc→comment→agent-reply→diff→accept→version-bump on disk, confirm files-are-truth (kill the server, files persist, restart rebuilds). Final `check-plugin` green + dist committed.
- **Demo:** the whole Agent Center, driven live end-to-end on a real run, every AC observably met.

---

## 6. Sequencing & parallel-safety (for the later split)

- **Strict order:** Phase 0 → 1 gate the rest (no UI without the build + spine). Within a phase, build the **risky seam first**: Phase 3's `markdown-serializer` + golden tests before the editor UI; the `write-service` safety boundary before the diff UI.
- **Parallel-safe within a phase** (disjoint `owns`): in Phase 1, `port-lock`/`pidfile` ∥ `fs-work-repository`/ `work-reader` ∥ the `web` shell. In Phase 4, the four pages are disjoint (`Agents`∥`Tokens`∥`Memory`∥`Gates`) once `event-store`/`gate-inbox`/`token-reader`/`mem-reader` exist — so build the readers first (shared seam), then fan out the pages.
- **Same-package parallel caveat (recalled):** web and server are one compile unit each; a sibling's in-progress type error in an *unowned* file is in-progress noise — brief implementers to report-not-fix, and run the authoritative typecheck AFTER each wave (not per-implementer).
- **Shared seams that need one owner (serialize via `deps`):** `shared/src/types.ts` (the read-model contract) produced before its consumers; `markdown-serializer` owned by one task; `bundleSrcHash`/`check-plugin` edits owned by Phase 0 only.

---

## 7. Risks & open unknowns (for the gate)

1. **(Highest) The `*.localhost` + detached-spawn + focus-or-start loop is the one thing only provable live.** The reload-gated/full-restart memory means AC1/AC10 can pass in code and still fail live (a browser that won't resolve `*.localhost`, a detached spawn that the command can't health-probe, a focus that opens a new tab instead of the existing one). Phase 1 must end with a *live* AC1 check, not a unit test. **This is the single riskiest unknown the user should weigh in on** — specifically whether to accept `*.localhost` host-routing as the V1 mechanism or fall back to path-routing if live browser/focus behavior disappoints.
2. **Markdown round-trip fidelity** (ADR-004) — the golden corpus must cover the real artifact constructs (ADR decision cards, deps lists, code fences); a serializer gap silently corrupts an artifact. Mitigated by building the golden tests *first* in Phase 3 and the source-mode hatch.
3. **Transcript source for Tokens** is external (Claude Code session transcripts) — its on-disk location/shape is the least-pinned contract here; if it's unstable, Tokens may need a `research` spike. Lowest-risk page; can ship last or degrade gracefully.
4. **React Flow + Dagre at real run sizes** — the prototype proves the approach; large DAGs may need the ELK upgrade (VISION flags it as the escape hatch) — not a V1 blocker, a known later lever.

---

## Coverage check (AC → phase)

AC1→P1·P5 · AC2→P1 · AC3→P2 · AC4→P3 · AC5→P3 · AC6→P3 · AC7→P2(live node)·P3(diff) · AC8→P4 · AC9→P0·P5 · AC10→P5. **Every AC traces to ≥1 phase.** Task-level coverage is produced in the later split.
