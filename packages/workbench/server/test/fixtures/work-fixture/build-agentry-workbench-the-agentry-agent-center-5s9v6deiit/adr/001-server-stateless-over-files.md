---
id: ADR-001
title: The server is a stateless ports-and-adapters projection over the .agentry files
status: accepted
date: 2026-06-19
deciders: architect
---

# ADR-001 — The server is a stateless ports-and-adapters projection over the `.agentry/` files

## Context

The Workbench server must read every run's `spec.md`/`plan.md`/`adr/`/`tasks/`/`events.jsonl`/`.review/` and write
back two things — a review sidecar comment and an artifact edit — while the files remain truth (VISION §1, §7;
doc 10 §0). FLOW already owns the *write contract* (version stamping, status enum, lock field, 3-way anchor); the
Workbench must not reimplement or diverge from it. The repo's house style for any file-touching service is
ports-and-adapters with dependencies pointing inward (`@agentry/memory`, `@agentry/flow` both prove it: `domain →
application → persistence → tools`, the domain imports no I/O — recalled repo-fact). The risk is building the
server as an ad-hoc Express app that grows its own in-memory model of runs and silently becomes a second
datastore — the exact anti-pattern VISION forbids.

## Decision

The server is **ports-and-adapters, stateless over the files**, mirroring `@agentry/flow`'s layering:

- `domain/` — pure read-model shapes (`RunSummary`, `GraphModel { nodes, edges }`, `DocModel`, `ReviewModel`,
  `EventView`) and the **ports** the rest depends on (`WorkRepository`, `Watcher`, `Transport`, `Clock`). No I/O.
- `application/` — the **aggregator** services that turn raw FLOW files into the read-models the UI consumes:
  `WorkReader` (parse a run dir → graph + docs), `EventStore` (fold every run's `events.jsonl` + hook lines via
  FLOW's own `parseLogLine` → a per-project timeline), `GateInbox` (scan `.review/*` → the waiting-on-you list),
  `WriteService` (the two write paths). Pure of HTTP/ws.
- `persistence/` — fs adapters: `FsWorkRepository` (readdir/parse), `ChokidarWatcher` (file-watch), `MemReader`
  (read-only over the `mem` file-store), `TranscriptReader` (Claude Code session transcripts for Tokens).
- `transport/` — the thin edges: `http` (serve the built UI + REST write-endpoints), `ws` (push file-change
  events), `host-router` (`*.localhost` → run id, ADR-002).
- `index.ts` — composition root: probe/lock the port, wire adapters into services, start the transports.

**The only state the server holds is a cache invalidated by the watcher.** Restart rebuilds everything from disk;
nothing is lost (doc 10 §6). The dependency arrow points inward: `domain` imports nothing; `application` imports
`domain`; `persistence`/`transport` import `application`+`domain`; `index` wires them.

**Reuse FLOW's parsing/write semantics, do not fork them.** `parseLogLine`, the frontmatter regex, the
`computeVersion` hash, and the `ReviewComment`/`ReviewAnchor`/`FlowEvent` shapes live in `@agentry/flow`'s
`domain/`. Where the Workbench needs them it **depends on `@agentry/flow` (workspace:\*)** for the shapes and the
hash function rather than copying them — so a FLOW schema change can't silently desync the two writers
(see ADR-005 for the type-home rule).

## Alternatives

1. **Ad-hoc Express service with an in-memory run model.** Rejected: it drifts into a second datastore (the named
   anti-pattern), and a restart would lose anything not flushed. Fails the files-are-truth law.
2. **Reimplement the FLOW frontmatter/version/anchor parsing locally** (no dep on `@agentry/flow`). Rejected: two
   independent writers of the same on-disk contract is the "harden both ends of a shared-file seam" gotcha waiting
   to happen — a FLOW version-hash change would leave the Workbench stamping a stale hash and every save would be
   wrongly rejected. Depend on the one source.
3. **A flat single-module server** (`server.ts` does watch + serve + route + write). Rejected: it's the god-file
   the repo's code-bar forbids; watch, host-routing, lock-enforcement, and aggregation are four distinct
   reasons-to-change.

## Consequences

- **Good:** restart-safe by construction; testable application core with fake ports (no fs/ws needed); a FLOW
  contract change surfaces as a compile error against the shared shapes, not a silent runtime desync.
- **Good:** the read-models are the exact seam the React app consumes — the UI never parses raw FLOW files.
- **Cost:** an explicit dependency `@agentry/workbench/server → @agentry/flow` (workspace), which means the server
  bundle's dist-lockstep must hash FLOW's `src` too — already handled by `bundleSrcHash`'s transitive coverage
  (ADR-004), so this is free.
- **Cost:** more files than a one-shot server. Justified: this is a multi-actor, long-lived subsystem (the floor is
  set by the actors — watch/route/lock/aggregate — not by line count).
