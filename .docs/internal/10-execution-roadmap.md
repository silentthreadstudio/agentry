# 10 — Execution Roadmap (0 → completion)

> **Status:** Living · **Date:** 2026-06-13 · **Scope:** the build plan from current state to a proven,
> released Agentry. Phases are **dependency-gated, not time-boxed** — each ends with a hard **acceptance
> gate**. *Do not advance a phase until its gate is green.* That single rule is what stops v1's "ship on
> vibes → 0.6 that's really a beta" failure.

## Standing rules (every phase)

- **Acceptance-gated** — a phase is done only when its Definition of Done is *demonstrated*, not assumed.
- **Reload-gated** — agent/command/skill/hook/MCP changes register only on plugin reload / session
  restart. Batch live verification after a restart; "lands green in code" ≠ "works live."
- **Dist-lockstep** — any `packages/memory/src` change → rebuild + commit `dist/index.js` in the same
  change. `node scripts/check-plugin.mjs` before every commit.
- **Dogfood from Phase 2 on** — once the spine runs, build later phases *through* `/agentry` where it
  helps. Every friction becomes an Evolution entry (doc 01 §5) — the flywheel.
- **Benchmark is the regression gate** — once it exists (Phase 3), it guards every later change.

---

## Phase 0 — Foundation ✅ DONE

Design + scaffold + repo.
- ✅ 9 design docs (01–09) · roster (8 agents + 13 skills + refs) · conductor (`/agentry`) + 10 nodes
- ✅ Plugin assembled (manifests · `.mcp.json` · primer hook · `@agentry/core` contract · `@agentry/memory`
  scaffold · check-plugin gate · workspace config) · private repo pushed
- **Gate:** `check-plugin` green; repo live. ✅

---

## Phase 1 — Memory core: the moat goes live ✅ DONE — live-verified

**Goal:** `@agentry/memory` implemented end-to-end (doc 07) — text-as-truth store + derived index + the tools.

**Live-verified:** `/mcp` green on a clean Markdown store; write→recall round-trips in-session; 6/6 tests.
**10 tools** (added `memory_feedback` + `memory_forget`). Three packaging bugs found+fixed by dogfooding
(FTS5-not-universal · root-`.mcp.json` double-load · CJS-in-ESM esbuild banner) — each now a stored gotcha.

**Tasks**
- [x] 1.1 `@agentry/core` is the contract; consumed by memory.
- [x] 1.2 **Persistence** — `file-store` (one JSON file per record · ULID ids · supersede-not-mutate) +
  `db-index`. *Simplification vs doc 07:* the index is **in-memory** `node:sqlite`/FTS5 rebuilt at startup
  (no DB file → nothing to gitignore, no temp+swap). Cleaner; the files remain the truth.
- [x] 1.3 **Application services** — `MemoryService` (write+dedup-reinforce · recall+prime · search ·
  update · feedback · stats · episode_write · distill/consolidate in `flows.ts`).
- [x] 1.4 **Tools** — 9 thin adapters (zod) + `index.ts` stdio server (MCP SDK) · two-root resolution.
- [x] 1.5 **Tests** — 5 `node:test` units green (round-trip · dedup-reinforce · rebuild-on-start ·
  supersede · episode/stats) + a headless stdio smoke (server starts, lists all 9 tools).
- [x] 1.6 **Build** — esbuild → committed `dist/index.js` (739KB, parses clean). Primer reads the real
  file-store layout.

**Definition of Done (gate):** `pnpm -r test` green ✅ · `check-plugin` green (dist present) ✅ · stdio smoke
lists 9 tools ✅ · round-trip / supersede-never-returned / rebuild-on-start all proven in tests ✅.
**Remaining (user, reload-gated):** restart a Claude Code session with the plugin installed and confirm
`/mcp` shows `mem` and a live `memory_write`→`memory_recall` round-trips. That flips the gate fully green.

**Risks:** `node:sqlite` API specifics on Node 24 · FTS5 query shape · esbuild externalizing `node:sqlite`.

---

## Phase 2 — End-to-end dogfood: the spine runs ✅ DONE — demonstrated across multiple real runs

**Goal:** a real task flows through `/agentry` with memory live.

**Tasks**
- [x] One-liner routes **one-shot** (no orchestration tax) — the no-dupes regression test (`f4b5002`).
- [x] Multi-file decompose+verify: spec gate · architect plan + ADR · **parallel implementers on disjoint
  contracts** · adversarial verify · assemble · ship gate — the mem-resync staleness fix (`a2d1e89`,
  T1→T4) and the roster-hardening sweep (`dd5e6e5`, 4 parallel implementers + verifier, proven in
  `events.jsonl`).
- [x] Memory loop end-to-end: recall-on-route · gotchas threaded · `used_memories` cited ·
  `memory_feedback` applied · `episode_write` on completion · `/agentry:reflect` distilled **4 facts with
  provenance** (the librarian run, debt 7→0).
- [x] Connective bugs surfaced + fixed durably: hooks.json wrapper (`33739dd`), block-scalar frontmatter
  (`ec5a2e8`), derived-index staleness (`a2d1e89`) — each hardened the layer, not the operator.

**Definition of Done (gate):** one multi-file task completes via decompose+verify with memory written
*and* recalled ✅; a one-liner stays one-shot ✅; reflect produces ≥1 distilled fact with provenance ✅.
**Green 2026-06-15.** Notable: the roster began *correcting the operator* (caught a stale-memory landmine
by reading current source) — the self-detection the spine was meant to enable.

---

## Phase 3 — Benchmark harness + first proof 🎯 NEXT

**Goal:** implement `benchmark/` (doc 06) and get the first C1–C4 numbers.

**Tasks**
- [ ] Task suite across R0/R1/R2/R3 (each with a **hidden** acceptance suite); R3 teacher→follow-up pairs.
- [ ] Runner — fresh sandbox per run · `claude -p --output-format json` · 3 arms (plain / cold / warm) · N repeats.
- [ ] Grading — AC pass-rate (primary) + cost (tokens/turns/wall-clock); the **cold-vs-warm moat experiment**.
- [ ] Scoreboard in `benchmark/` + the C1–C4 verdicts with deltas + variance.
- [ ] First calibration run → set the knobs (recall limit, decay, `K`, weights).

**Definition of Done (gate):** the scoreboard runs headlessly and reproducibly and reports C1–C4 with
mean+variance — **including an honest "no win in regime X"** if that's the result.

---

## Phase 4 — Harden to the numbers

**Goal:** act on Phase 3; make the claims true (or honestly scope them down).

**Tasks**
- [ ] Tune knobs (recall count · decay · write-bar precision · routing thresholds · scoring weights).
- [ ] Deepen any skill/agent the per-specialist benchmark shows underperforming.
- [ ] Re-run the benchmark; iterate until the gate holds.

**Definition of Done (gate):** C2 + C3 (orchestration) and C4 (moat) **clear their targets**, or a
documented decision to rescope a regime with the measured reason.

---

## Phase 5 — Workbench V2

**Goal:** the review surface (doc 08) over real artifacts.

**Tasks**
- [ ] Wire the V1 seams live: `events.jsonl` emission in the conductor/nodes · review-sidecar ingestion at
  the gate · `version` content-hash on artifacts (optimistic concurrency).
- [ ] Build `@agentry/workbench` — renderer + editor + review UI + thin local service (watch + websocket +
  lock-enforcing write endpoint). **Designed by the `designer` with the see-it loop** — no UI shipped unseen.
- [ ] Exploit native surfaces (`/workflows`, agent-view state, channels relay) before hand-rolling.

**Definition of Done (gate):** read/edit/comment/approve loop works over real artifacts; `in-progress`
lock honored; the gate loop resolves a sidecar comment with zero anchor drift; a11y ≥ AA on every view.

---

## Phase 6 — Release

**Goal:** a clean, installable, documented, proven release.

**Tasks**
- [ ] README leads with the benchmark numbers · CHANGELOG · version bump · `repository`/`homepage` in plugin.json.
- [ ] Verify **clean-clone install** (no dev env): clone → Node 24 → `/plugin install` → `/agentry` works.
- [ ] Tag the release; finalize the marketplace entry.

**Definition of Done (gate):** a clean clone installs and runs; docs match reality; release tagged.

---

## Completion

Agentry is **complete (v1)** when: the spine runs (P2), the benchmark proves the orchestration + moat
claims or honestly scopes them (P3–P4), and a clean clone installs and works (P6). The Workbench (P5)
ships V2. After that, the roadmap becomes the Evolution log — Agentry improving itself.

---

_Living doc — check off tasks and flip phase gates as they go green. The discipline is the gate: never
advance on vibes._
