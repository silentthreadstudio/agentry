# Coverage matrix — @agentry/workbench task split

Run: `build-agentry-workbench-the-agentry-agent-center-5s9v6deiit`
27 tasks across 6 phases (0–5). Sliced from the approved plan §2.1 / §5 / §6.
Gate decision threaded in: **routing = `*.localhost` host-routing exactly per ADR-002, no path-routing fallback** (T9, T11, T26).

## AC → task matrix (rows = AC1–AC10; cols = the tasks that satisfy each)

| AC  | What it asserts (spec.md) | Tasks |
| :-- | :-- | :-- |
| AC1 | `/agentry:workbench` focus-or-start; 2nd invocation focuses, never a 2nd server | **7** (port-lock/pidfile), **11** (command), **26** (live) |
| AC2 | Works lists every run w/ status/shape/agents; open routes to `<id>.localhost` showing Live+Activity | **8** (work-reader/repo), **9** (routes+host-router), **10** (Works home + shell), **26** |
| AC3 | Live = React Flow + Dagre no-overlap + typed edges + legend + hover-highlight | **6** (graph derivation), **12** (canvas+layout-dagre), **13** (DocNode/edges/legend/hover), **26** |
| AC4 | Node→Tiptap doc; in-progress read-only+lockedBy; todo/done editable; Take over flips lock | **15** (write-service lock), **16** (DocDrawer/LockBar/TakeOver/SourceMode), **17** (/takeover), **26** |
| AC5 | Span comment → 3-way-anchored `.review/<gate>.json` + rail + node badge | **15** (addComment), **17** (/comment), **18** (CommentMark/Rail/Bubble), **26** |
| AC6 | Stale-version save rejected (optimistic concurrency); fresh edit writes + bumps version | **14** (normalize byte-stability), **15** (optimistic concurrency), **16** (UI feedback), **17** (/artifact), **26** |
| AC7 | Agent change live-updates browser over ws (no reload); comment reply → before/after diff w/ Accept/Reject/Iterate | **8**+**9** (watcher→ws), **12** (live graph), **13** (live overlay), **17** (push on write), **19** (DiffDrawer), **26** |
| AC8 | Activity·Agents·Tokens·Memory·Gates each from real data, dark+calm | **20** (event-store/gate-inbox), **21** (token-reader/mem-reader), **22** (Activity/Agents), **23** (Gates), **24** (Tokens), **25** (Memory), **26** |
| AC9 | `pnpm --filter @agentry/workbench build` → committed `plugin/workbench/`; check-plugin green + validates new bundle lockstep | **2** (bundleSrcHash srcSubdir), **3** (server artifact), **4** (web artifact), **5** (root pkg + 2× checkBundle), **26** (final green) |
| AC10 | Verified live (real run, after the command launches it) — not just green | **26** (end-to-end live gate) |

**Every AC1–AC10 traces to ≥1 task.** ✓

## Tasks by phase (number · title · deps · parallel-safe group)

### Phase 0 — Scaffold + two-artifact build + dist-lockstep green (AC9 partial)
- **1** · shared package: read-model contract types (ADR-005) · deps [] · ∥ {2,3,4,5}
- **2** · bundleSrcHash additive srcSubdir (src-hash.mjs) · deps [] · ∥ {1,3,4,5}
- **3** · server scaffold: package.json + build.mjs + /healthz server · deps [2] · ∥ {1,4,5}
- **4** · web scaffold: package.json + vite.config + placeholder app · deps [2] · ∥ {1,3,4}
- **5** · root @agentry/workbench pkg + 2× checkBundle in check-plugin.mjs · deps [2,3,4] · ∥ {1}

### Phase 1 — Server spine + Works home + open-a-work (AC1, AC2)
- **6** · server domain: ports.ts + graph.ts (pure core) · deps [1,3] · ∥ {7}
- **7** · instance: port-lock + pidfile (singleton, ADR-002) · deps [3] · ∥ {6,8}
- **8** · persistence + work-reader: fs-work-repository + chokidar-watcher + work-reader · deps [6] · ∥ {7}
- **9** · transport + composition root: http/host-router/ws/routes/index.ts · deps [6,7,8] · ∥ {}
- **10** · web shell: router + sidebar + design-system + api/ws-client + Works home · deps [1,4] · ∥ {6,7,8,9}
- **11** · the `/agentry:workbench [work]` command (ADR-002) · deps [3,7] · ∥ {6,8,9,10}

### Phase 2 — The panorama (React Flow graph) (AC3, AC7-live-graph)
- **12** · Panorama: React Flow canvas + Dagre layout (no overlap) · deps [1,9,10] · ∥ {}
- **13** · DocNode + typed edges + legend + hover + live overlay · deps [12] · ∥ {}

### Phase 3 — Document layer: Tiptap + comment + lock + version + diff (AC4–AC7) — risky seam first
- **14** · markdown-serializer + golden corpus (the tripwire, ADR-004) · deps [1] · ∥ {15}
- **15** · write-service + flow-writer (lock + optimistic concurrency, ADR-006) · deps [6,8] · ∥ {14}
- **16** · DocDrawer + LockBar/TakeOver + SourceMode (AC4) · deps [14,12] · ∥ {15}
- **17** · write POST endpoints /comment,/artifact,/takeover · deps [15,9] · ∥ {16}
- **18** · CommentMark + CommentRail + SelectionBubble (AC5) · deps [16,17] · ∥ {19}
- **19** · DiffDrawer: live ws + before/after + Accept/Reject/Iterate (AC7) · deps [16,17] · ∥ {18}

### Phase 4 — Secondary pages (AC8) — readers first, then fan out
- **20** · readers 1/2: event-store + gate-inbox + /api/{events,agents,gates} · deps [6,8,9] · ∥ {21}
- **21** · readers 2/2: token-reader + mem-reader + /api/{tokens,memory} · deps [6,9] · ∥ {20}
- **22** · pages: Activity + Agents · deps [20,10] · ∥ {23,24,25}
- **23** · page: Gates (waiting-on-you inbox) · deps [20,10] · ∥ {22,24,25}
- **24** · page: Tokens (charts) · deps [21,10] · ∥ {22,23,25}
- **25** · page: Memory (read-only browse/search) · deps [21,10] · ∥ {22,23,24}

### Phase 5 — End-to-end live verification + polish (AC10, final AC9)
- **26** · end-to-end live verification on a real run (the never-green-only gate) · deps [11,13,17,18,19,22,23,24,25] · ∥ {27}
- **27** · cross-cutting design + a11y polish pass · deps [22,23,24,25,13,16,18,19] · ∥ {26}

## Shared-seam single-owners (sequenced first, consumers `deps` on them)
- `shared/src/types.ts` → **task 1** (the read-model contract; every consumer deps on it).
- `scripts/lib/src-hash.mjs` `srcSubdir` → **task 2** (Phase 0 only); `scripts/check-plugin.mjs` → **task 5** (Phase 0 only).
- server `domain/ports.ts` + `graph.ts` → **task 6** (the server-internal seam Phase 1+ deps on).
- `markdown-serializer.ts` + `normalize` → **task 14** (the ONE md↔Tiptap module, golden-tested first).
- `write-service` (the lone write boundary) → **task 15** (before the diff/endpoint UI).

## Same-file additive coordination (no live overlap — append-only to a merged Phase-1 file)
- `transport/routes.ts` is created by **task 9** (GETs + write room left). Tasks **17** (POST write handlers), **20** (events/agents/gates GETs), **21** (tokens/memory GETs) each *append* their handlers to the already-merged file. Sequenced by deps so the file is stable when each appends; each task's contract notes "ADD only, do not refactor task 9's code." If concurrency is desired across 17/20/21, serialize the merge of these three (they touch one file) — deps already gate them behind task 9.

## Slicing judgment calls (flagged for the conductor)
1. **`graph.ts` ownership (task 6 vs Phase 2).** Plan §2.1 lists `graph.ts` once but Phase 2 "extends" it for the live overlay. I gave the **pure derivation** (`buildGraph`, edge-typing) to task 6 (it is pure + testable in Phase 1) and the **visual/live overlay** to task 13 (web-side `DocNode`/`edge-types`) — so the server `graph.ts` file has exactly one owner (task 6) and Phase 2 consumes its output, no shared-file edit.
2. **`routes.ts` is touched by 4 tasks (9 create, 17/20/21 append).** Re-slicing to give each endpoint group its own router file was the alternative; I kept one `routes.ts` (matches the plan §2.1 single-file listing) and made 17/20/21 strictly additive behind task 9's merge — documented as append-only with the serialize-the-merge note. This is the one place the contracts touch a shared file; deps + the append-only rule keep it safe.
3. **Readers split 20/21 (not one task, not four).** Plan §6 says "build the readers first (shared seam), then fan out." Four readers in one task = a god-task; four separate tasks = over-shatter on tightly-coupled folds. Split by cohesion: run-aggregation folds (event-store + gate-inbox, both over `events.jsonl`/`.review/`) vs external-source readers (token-reader transcripts + mem-reader file-store). Each is a clean `owns` boundary; the four pages then fan out parallel.
4. **Phase 5 split into 26 (behavioral live gate) + 27 (design/a11y polish).** Both are cross-cutting; I kept them parallel-safe (26 verifies behavior, 27 polishes visuals/a11y) rather than one god-task. 27's edits are scoped additive (design-system + a11y); substantive redesigns route back to the owning page task.
5. **Command (task 11) is one markdown file** — deliberately right-sized as a single bounded task, not over-structured (CLAUDE.md counterweight: a ~bounded gate stays one file).

## Notes
- **Reload-gated** (recalled): the command (11) + server register only on plugin reload/restart — live AC1/AC10 verification (26) MUST run after a restart, not in code.
- **Same-package typecheck caveat** (recalled): web and server are one compile unit each; run the authoritative typecheck AFTER each wave, not per-implementer; a sibling's in-progress type error in an unowned file is in-progress noise (report-not-fix).
- **Dist-lockstep** (recalled, content-hash based): any `packages/workbench/{web,server}/src` (or `@agentry/flow/src`) change ⇒ rebuild + commit the artifact + `.srchash` in the same change.
