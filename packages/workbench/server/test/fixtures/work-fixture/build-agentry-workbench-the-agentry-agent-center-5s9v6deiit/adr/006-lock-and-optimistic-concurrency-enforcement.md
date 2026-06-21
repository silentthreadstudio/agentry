---
id: ADR-006
title: Lock + optimistic-concurrency are enforced server-side at the write boundary, keyed on FLOW's version hash and task status
status: accepted
date: 2026-06-19
deciders: architect
---

# ADR-006 — Lock + optimistic-concurrency enforcement at the write boundary

## Context

The two write paths (review comment, artifact edit) must be safe against the AI↔Dashboard clobber (VISION §6,
doc 10 §4): editing under the agent's lock is read-only, and a save against a stale version is rejected (AC4, AC6).
FLOW already produces the two signals — task `status: in-progress` ⇒ locked-by-the-assignee, and the `version`
content-hash on every artifact. The fork: *where* is this enforced (client trust vs server), and *what* does the
client present to prove freshness, given the round-trip serializer (ADR-004) means the client never holds the raw
file bytes?

## Decision

**Both invariants are enforced server-side at the `WriteService` boundary; the client is never trusted, and the
freshness key is the FLOW version hash carried opaquely.**

- **Lock check.** Before an artifact write, `WriteService` re-reads the task's current frontmatter from disk
  (truth), and if `status === "in-progress"` the write is **rejected** with the `lockedBy` value (the UI shows
  "implementer is editing this now"). The client's belief about the lock is advisory only — a concurrent
  `task_status(in-progress)` by the agent between page-load and save is caught because the check reads disk at
  write time, not at open time. **Take over** is an explicit lock transition the server performs (it is the human
  claiming the edit); only after it succeeds is the write allowed. Comments are allowed even when locked (you can
  always annotate; VISION §5) — the lock gates *edits*, not *comments*.
- **Optimistic concurrency.** When the client opens a doc it receives the current `version` hash (read from
  frontmatter). On save it sends back `{ run, kind/taskNo, baseVersion, newBody }`. `WriteService` recomputes the
  **current** on-disk version (via FLOW's `computeVersion` over the normalized body + frontmatter-sans-version) and
  **rejects if it differs from `baseVersion`** (someone — the agent — wrote in between). On success it writes
  through the FLOW write path, which **re-stamps** a fresh version, and pushes the new version to the client. The
  client never computes or supplies a version (FLOW owns the hash; the client only echoes the opaque `baseVersion`
  it was given) — identical to FLOW's "caller never supplies version" rule.
- **Normalization bridges the serializer.** Because ADR-004 normalizes the body identically on read and on write,
  a no-op editor session re-serializes to the same bytes → the same `computeVersion` → `baseVersion` matches →
  the save is a clean no-op (not a false stale-rejection). This is the load-bearing link between ADR-004 and this
  ADR.
- **Write mechanism.** The server writes by the **same on-disk contract FLOW uses** (the frontmatter+body render
  that stamps `version`), reusing `@agentry/flow`'s shapes/hash (ADR-005). V1 may write the file directly through
  a small adapter that replicates `TaskFileStore`'s render (it is the same package's contract); it does **not**
  call the FLOW MCP over stdio (the Workbench server and the FLOW MCP are separate processes — direct file write
  with the shared render is simpler and keeps files-are-truth). The shared `computeVersion`/frontmatter shapes are
  what keep the two writers byte-compatible.

## Alternatives

1. **Client-side lock/version check (trust the browser).** Rejected: the agent writes between open and save; only
   a write-time disk read is correct. Client checks are a UX hint, not the guarantee.
2. **Call the FLOW MCP's `artifact_write` from the server** to reuse its stamping. Rejected for V1: the FLOW MCP is
   a stdio server owned by the Claude session, not a service the Workbench server can invoke; spawning it or
   bridging stdio is complexity the shared `computeVersion` + render makes unnecessary. Reuse the *code* (shapes +
   hash), not the *process*.
3. **A separate lockfile owned by the Workbench.** Rejected: the lock already exists as FLOW's `status:
   in-progress` + `lockedBy`; inventing a second lock is a second source of truth and a desync risk.

## Consequences

- **Good:** the two directions provably can't clobber — every edit is gated on a fresh disk read of both signals;
  the guarantee lives at one boundary (`WriteService`), testable with fake ports.
- **Good:** the client stays dumb about versioning (echoes an opaque token), so the hash algorithm can change in
  FLOW without touching the UI.
- **Cost:** the Workbench server replicates FLOW's frontmatter-render in a small adapter (shared shapes/hash, not
  shared code path). The dist-lockstep transitive hash over `@agentry/flow/src` is the tripwire if the FLOW render
  changes and the adapter doesn't — that staleness shows up as a stale `server` bundle (ADR-003).
- **Verify live (AC10):** a real concurrent agent write must be shown to reject a stale Workbench save, and Take
  over must be shown to flip a real `in-progress` lock — code-green is not enough (reload-gated memory).
