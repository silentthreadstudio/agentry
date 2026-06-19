// host-router — parse the run context off the request's `Host` header (ADR-002). Routing is
// `*.localhost` EXACTLY: the leading DNS label of `<id>.localhost` IS the run id; bare `localhost` and
// the reserved `workbench.localhost` carry no run context (the Works home). There is NO path-routing
// fallback in V1 (the user-gate decision threaded into task 9) — `/api/...` is the REST namespace under
// every host, never a way to address a run.
//
// PURE: a string in (the Host header value), a parsed result out — no I/O, fully unit-testable. The
// run label is validated through FLOW's `assertSafeSegment` (the SAME traversal guard FLOW uses, ADR-002
// — reuse, don't reinvent): a poisoned label (`..localhost`, `a/b.localhost`) can never become a run
// context, so nothing downstream can escape `.agentry/work/`.
import { assertSafeSegment } from "@agentry/flow/domain/ids";

// The reserved bare-home labels: `localhost` itself and the explicit `workbench.localhost` both resolve
// to the Works home (no run). Anything else's leading label is a candidate run id.
const HOME_LABELS = new Set(["localhost", "workbench"]);

// The run context attached to a request. `run` is the resolved run id for a `<id>.localhost` host, or
// null for the Works home (bare `localhost` / `workbench.localhost` / a header that names no run).
export interface RunContext {
  run: string | null;
}

// Resolve the run context from a raw `Host` header value (e.g. `flow-mcp-v1.localhost:4317`).
//
//  - `<id>.localhost[:port]` → `{ run: <id> }` when `<id>` passes `assertSafeSegment`.
//  - `localhost` / `workbench.localhost` → `{ run: null }` (Works home).
//  - a missing/empty header, a host that is not `*.localhost`, or a label that fails the traversal guard
//    → `{ run: null }` (no run context — never a throw that would 500 a request, and never a poisoned id).
//
// Only the host portion is read; the `:port` suffix is stripped first (the `Host` header carries it).
export function resolveRunContext(hostHeader: string | undefined): RunContext {
  if (hostHeader === undefined || hostHeader.length === 0) return { run: null };

  // Strip the port suffix — `Host` is `name:port` (e.g. `id.localhost:4317`). IPv6 hosts are bracketed
  // (`[::1]:4317`) and are never a `*.localhost` name, so a simple last-colon split is safe here.
  const host = hostHeader.split(":")[0] ?? "";
  const labels = host.split(".");

  // Routing is `*.localhost` EXACTLY: the host must end in the `localhost` TLD label, nothing else.
  if (labels[labels.length - 1] !== "localhost") return { run: null };

  // Bare `localhost` (one label) is the Works home; the run id is the leading label of `<id>.localhost`.
  const leading = labels[0] ?? "";
  if (HOME_LABELS.has(leading) || labels.length < 2) return { run: null };

  // Validate the run label through FLOW's traversal guard — a poisoned label resolves to no run.
  try {
    assertSafeSegment(leading);
  } catch {
    return { run: null };
  }
  return { run: leading };
}
