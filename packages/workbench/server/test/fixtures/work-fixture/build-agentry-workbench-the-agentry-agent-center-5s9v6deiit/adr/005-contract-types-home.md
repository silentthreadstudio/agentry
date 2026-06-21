---
id: ADR-005
title: Workbench contract types — reuse FLOW's domain shapes; read-model types stay local; nothing new goes in @agentry/core
status: accepted
date: 2026-06-19
deciders: architect
---

# ADR-005 — Where the Workbench's contract types live

## Context

The repo law: **types live in `@agentry/core`, the single source of truth; never duplicate a contract type across
packages** (CLAUDE.md, recalled). But FLOW deliberately put its *closed* event/review/status shapes in
`@agentry/flow`'s own `domain/` — **not** in core — because core's `WorkEvent` is intentionally loose (so the
dep-free hook can write it) and FLOW needed a closed union the loose shape can't express (recalled FLOW ADR-002).
The Workbench consumes three categories of types: (a) the **on-disk FLOW contract** (FlowEvent, FlowTaskStatus,
ReviewComment, ReviewAnchor, the version hash) it reads and writes back; (b) **server↔client read-models** (the
graph model, the doc model, the gate-inbox item) that exist only to ferry data from the aggregator to the React
app; (c) **pure UI view-models** (React Flow node/edge data). The wrong call here is either duplicating FLOW's
shapes (desync risk) or dumping Workbench-only transport types into `@agentry/core` (polluting the shared contract
with UI concerns).

## Decision

A three-tier rule, by category:

1. **The on-disk FLOW contract → reuse `@agentry/flow`'s `domain/` shapes directly** (`FlowEvent`,
   `FlowTaskStatus`, `AgentState`, `ReviewComment`, `ReviewAnchor`, `parseLogLine`, `computeVersion`). The server
   package takes `@agentry/flow` as a `workspace:*` dependency and imports these. **Zero duplication** — the
   Workbench writes the exact shape FLOW writes, and a FLOW schema change is a compile error here, not a runtime
   desync. This honors "never duplicate a contract type" by pointing at the *existing* home (flow/domain), which is
   where FLOW's own ADR-002 already established these live (not core).
2. **Server↔client read-models → local to the workbench package, in `server/src/domain/` and shared with the web
   via a small `packages/workbench/shared/` (or a re-exported `web/src/api/types.ts`).** These (`RunSummary`,
   `GraphModel`, `DocModel { frontmatter, body }`, `GateItem`, `EventView`, `TokenSeries`) are a *transport
   contract between this package's own two halves* — not a cross-package contract. They belong with the package
   that owns both ends, exactly as `@agentry/eval` defined its own local `EvalEvent` rather than importing core
   (recalled: the self-eval overrode a core-reuse ADR when the wiring cost surfaced — same judgment applies).
3. **Pure UI view-models → local to `web/src`,** never leave the web layer.

**`@agentry/core` gains nothing.** No Workbench type is a shared cross-package contract; adding transport/UI types
to core would pollute the single source of truth with surface concerns. If — and only if — a *future* second
consumer needs a Workbench read-model, that's the trigger to promote it (YAGNI until then).

## Alternatives

1. **Put the read-models in `@agentry/core`.** Rejected: they are UI/transport concerns with one producer and one
   consumer (this package's two halves); core is for shapes shared *across* packages. Premature and polluting.
2. **Duplicate FLOW's FlowEvent/ReviewComment shapes locally** to avoid a `@agentry/flow` dependency. Rejected:
   two writers of one on-disk contract = the desync gotcha; and it would re-fork the closed-union-in-domain
   decision FLOW already made. Depend on flow/domain.
3. **Move FLOW's domain shapes into core so both flow and workbench import them from core.** Rejected: FLOW's
   ADR-002 deliberately kept the closed union out of core (to keep the dep-free hook from importing the contract
   package); re-opening that is out of scope and re-litigates a settled fork.

## Consequences

- **Good:** zero contract duplication; the Workbench writes byte-compatible FLOW files because it imports FLOW's
  own shapes and hash function; a FLOW change ripples as a typecheck failure.
- **Good:** core stays clean — only genuinely shared contracts live there; the Workbench's transport types stay
  with the package that owns both their producer and consumer.
- **Cost:** a `@agentry/workbench/server → @agentry/flow` workspace dependency, which the dist-lockstep already
  covers transitively (ADR-003/004). The web half stays dependency-free of core/flow at the type level (it talks
  to the server over the local read-model API), so the web bundle's hash has no workspace deps to walk.
- **Cost:** the read-models are defined once and shared across the package's two src roots — a small `shared/`
  surface or a re-export, which the split (planning) must give a single owner so web and server don't each define
  their own drifting copy.
