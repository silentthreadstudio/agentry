// host-router — parse the run LABEL off the request's `Host` header (ADR-002). Routing is
// `*.localhost` EXACTLY: the leading DNS label of `<label>.localhost` names a run; bare `localhost` and
// the reserved `workbench.localhost` carry no run (the Works home). There is NO path-routing fallback in
// V1 (the user-gate decision threaded into task 9) — `/api/...` is the REST namespace under every host,
// never a way to address a run.
//
// The leading label is NOT necessarily the full run id: long FLOW run ids are served at a short
// `workSlug` subdomain (task 003), so the label may be a slug that resolves back to the full id, or the
// full id itself (back-compat / terse ids). This parse stays PURE — a string in, the parsed LABEL out,
// no I/O — and leaves the label→run resolution to the layer that holds the run list (the composition
// root in `http.ts`, via `@agentry/workbench-shared`'s `resolveSlug`). The label is validated through
// FLOW's `assertSafeSegment` (the SAME traversal guard FLOW uses, ADR-002 — reuse, don't reinvent): a
// poisoned label (`..localhost`, `a/b.localhost`) can never become a run context, so nothing downstream
// can escape `.agentry/work/`.
import { assertSafeSegment } from "@agentry/flow/domain/ids";

// The reserved bare-home labels: `localhost` itself and the explicit `workbench.localhost` both resolve
// to the Works home (no run). Anything else's leading label is a candidate run label.
const HOME_LABELS = new Set(["localhost", "workbench"]);

// The host's run context. `run` is the resolved FULL run id (the composition root resolves the parsed
// label through `resolveSlug` before building this), or null for the Works home / an unresolvable host.
export interface RunContext {
  run: string | null;
}

// Parse the run LABEL from a raw `Host` header value (e.g. `flow-mcp-v1.localhost:4317`). The label is a
// candidate run id OR a `workSlug` — the caller resolves it to a full id (see `host-router` doc above).
//
//  - `<label>.localhost[:port]` → `<label>` when it passes `assertSafeSegment`.
//  - `localhost` / `workbench.localhost` → `null` (Works home).
//  - a missing/empty header, a host that is not `*.localhost`, or a label that fails the traversal guard
//    → `null` (no run — never a throw that would 500 a request, and never a poisoned label).
//
// Only the host portion is read; the `:port` suffix is stripped first (the `Host` header carries it).
export function parseHostLabel(hostHeader: string | undefined): string | null {
  if (hostHeader === undefined || hostHeader.length === 0) return null;

  // Strip the port suffix — `Host` is `name:port` (e.g. `id.localhost:4317`). IPv6 hosts are bracketed
  // (`[::1]:4317`) and are never a `*.localhost` name, so a simple last-colon split is safe here.
  const host = hostHeader.split(":")[0] ?? "";
  const labels = host.split(".");

  // Routing is `*.localhost` EXACTLY: the host must end in the `localhost` TLD label, nothing else.
  if (labels[labels.length - 1] !== "localhost") return null;

  // Bare `localhost` (one label) is the Works home; the run label is the leading label of `<x>.localhost`.
  const leading = labels[0] ?? "";
  if (HOME_LABELS.has(leading) || labels.length < 2) return null;

  // Validate the label through FLOW's traversal guard — a poisoned label resolves to no run.
  try {
    assertSafeSegment(leading);
  } catch {
    return null;
  }
  return leading;
}
