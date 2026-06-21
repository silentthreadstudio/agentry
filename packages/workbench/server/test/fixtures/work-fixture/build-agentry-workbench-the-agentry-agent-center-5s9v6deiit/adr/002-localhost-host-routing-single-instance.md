---
id: ADR-002
title: One instance per project — pidfile + port-lock, named-domain (*.localhost) host-routing by run id
status: accepted
date: 2026-06-19
deciders: architect
---

# ADR-002 — Single instance (pidfile + port-lock) and `*.localhost` host-routing by run id

## Context

VISION §7 / doc 10 §1 require **exactly one server per project** on a fixed port (`:4317`), and each run reachable
at its own URL `<id>.localhost:4317` with **no `/etc/hosts` edit** (`*.localhost` auto-resolves to `127.0.0.1`,
RFC 6761). `/agentry:workbench [work]` must **focus-or-start** — a second invocation must never spawn a second
server (AC1). Two sub-problems: (a) how do we guarantee singleton-ness across separate command invocations and
process crashes, and (b) how does one process serve many run-scoped URLs.

## Decision

**Singleton = bind-the-port-is-the-lock, with a pidfile carrying the liveness/deep-link metadata.**

- The fixed listen port `:4317` is itself the mutual-exclusion primitive: a second `listen()` on the same port
  fails with `EADDRINUSE` — the OS guarantees only one binder. The command treats a successful bind as "I am the
  server"; an `EADDRINUSE` (or a successful health probe) as "one is already up → focus it."
- A **pidfile** at `<projectRoot>/.agentry/run/workbench.json` carries `{ pid, port, startedAt }`. It is advisory
  metadata for the command (liveness via `process.kill(pid, 0)`, and the port to open), **not** the lock — the
  port bind is the lock. A stale pidfile (process dead, port free) is overwritten on the next start; the bind, not
  the file, decides. Written atomically (tmp-then-rename, the pattern `run-pointer.ts` already uses) and removed on
  graceful shutdown.
- The command flow (AC1): resolve project root → probe `http://127.0.0.1:4317/healthz` → **up** ⇒ open
  `http://<id>.localhost:4317` (focus); **down** ⇒ `node plugin/workbench/server/index.js` detached → poll
  `/healthz` until ready → open the deep link. Never two servers.

**Host-routing = the run id is the subdomain label; routing is read off the `Host` header, content is one SPA.**

- All `<id>.localhost:4317` requests hit the same process. A `host-router` middleware parses the leading DNS label
  off `Host` (`flow-mcp-v1.localhost` → `flow-mcp-v1`), validates it through **FLOW's `assertSafeSegment`** (a
  poisoned label can never escape `work/` — same guard FLOW uses), and attaches it as the request's run context.
- The **same built SPA** is served for every host; the run id is injected (a `<meta name="agentry-run">` tag or a
  `/api/context` bootstrap call) so the React app opens straight into that work. The bare `localhost:4317` /
  `workbench.localhost` host serves the **Works home** (no run context). "Multiple workbenches" = multiple named
  browser tabs off one process (doc 10 §1).
- The websocket and REST endpoints are equally host-scoped: a `ws` connection on `<id>.localhost` only receives
  that run's file-change events; a write endpoint resolves its run from the host.

## Alternatives

1. **A lockfile with an advisory `flock` / pidfile-as-lock instead of the port bind.** Rejected: racy across the
   gap between "read pidfile" and "decide to start," and a crash can strand the lock. The port bind is atomic and
   self-cleaning (the OS releases it on process death) — strictly better for the singleton guarantee.
2. **Path-based routing (`localhost:4317/work/<id>`) instead of subdomains.** Rejected: VISION/doc 10 explicitly
   chose named domains so each work is a real, bookmarkable, separately-focusable browser tab/URL with its own
   document title and history; path routing collapses them into one origin. (Path routing stays available as the
   internal REST namespace — `/api/...` — under each host.)
3. **A second server per run.** Rejected outright by AC1 (exactly one instance) and the stateless-over-files model
   (ADR-001) — one watcher over the whole `.agentry/work` tree is simpler and cheaper than N processes.

## Consequences

- **Good:** the singleton guarantee is OS-enforced and crash-safe; no stale-lock recovery logic to get wrong.
- **Good:** one watcher, one event store, one process — the cross-cutting pages (Activity/Agents/Tokens/Gates)
  aggregate across every run for free because they live in the same process (doc 10 §5).
- **Cost:** `*.localhost` subdomain resolution is a modern-browser behavior; a CLI `curl` needs `--resolve` or the
  `Host` header. Acceptable — the Workbench is a browser app, and the health probe uses `127.0.0.1` directly.
- **Cost:** the host label must be sanitized on every request (traversal guard) — handled by reusing FLOW's
  `assertSafeSegment`, no new security surface invented.
- **Risk to verify live (AC10):** that the detached spawn + `/healthz` poll + browser-open actually focuses an
  existing instance on a real second invocation — the reload-gated/full-restart memory means this must be checked
  live, not just in code.
