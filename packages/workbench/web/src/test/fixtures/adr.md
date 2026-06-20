# ADR-001 — The server is a stateless ports-and-adapters projection over the `.agentry/` files

## Context

The Workbench server must read every run's `spec.md`/`plan.md`/`adr/`/`tasks/` and write back two things — a
review sidecar comment and an artifact edit — while the files remain truth. FLOW already owns the *write
contract* (version stamping, status enum, lock field, 3-way anchor); the Workbench must **not** reimplement or
diverge from it.

## Decision

The server is **ports-and-adapters, stateless over the files**, mirroring `@agentry/flow`'s layering:

- `domain/` — pure read-model shapes and the **ports** the rest depends on. No I/O.
- `application/` — the **aggregator** services that turn raw FLOW files into read-models.
- `persistence/` — fs adapters: `FsWorkRepository`, `ChokidarWatcher`, `MemReader`.
- `transport/` — the thin edges: `http`, `ws`, `host-router`.

## Alternatives

1. **Ad-hoc Express service with an in-memory run model.** Rejected: it drifts into a second datastore.
2. **A derived index/database.** Rejected: a cache that outlives the process is state to keep in sync.

## Consequences

- **Good:** restart rebuilds everything from disk; nothing is lost.
- **Good:** reusing FLOW's parsing means a schema change can't silently desync the two writers.
- **Cost:** every read re-parses the files — acceptable at a single-project scale.
