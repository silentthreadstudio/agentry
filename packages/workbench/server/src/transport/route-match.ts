// route-match — the pure path matchers + run resolution shared across the dispatchers. Each matcher
// recognizes ONE pinned path shape and returns its decoded segment(s) or null; it never touches the
// request body or verb (the dispatcher gates those). The id segments are `decodeURIComponent`d so a
// percent-encoded run/doc id round-trips; the traversal safety stays the host-router/WorkReader's
// `assertSafeSegment` guard downstream, not these matchers (a matcher only shapes, never validates).
import { resolveSlug } from "@agentry/workbench-shared";
import type { WorkReader } from "../application/work-reader.js";

// The write-path kinds the POST dispatcher serves — the closed set `matchWritePath` discriminates.
export type WriteKind = "comment" | "resolve" | "artifact" | "takeover" | "status";

// The `?run=<id>` query param decoded to a run id, or undefined when absent/empty. The URL layer already
// percent-decodes the value; the traversal safety is the store's `runDir`/`assertSafeSegment` guard.
export function runParam(url: URL): string | undefined {
  const run = url.searchParams.get("run");
  return run !== null && run.length > 0 ? run : undefined;
}

// Resolve a `:id` path segment (or a `?run=` value) to a FULL run id. The segment may be a short
// `workSlug` subdomain label (task 003) — the SPA, running at `<workSlug>.localhost`, issues paths whose
// id IS its host label — or the full run id itself (back-compat / terse ids). `resolveSlug` (shared)
// scans the known runs: an exact id match OR a `workSlug` match wins; an unresolvable label is undefined
// (the caller turns that into a 404, never a 500). The traversal safety stays the reader's
// `assertSafeSegment` guard — `resolveSlug` only ever returns an id that is actually present.
export function resolveRun(reader: WorkReader, label: string): string | undefined {
  return resolveSlug(label, reader.listRuns());
}

// Match `/api/work/:id/graph` → the (still-decoded) run id, or null. The id segment is `decodeURIComponent`d
// so a percent-encoded run id round-trips; the host-router/WorkReader's `assertSafeSegment` is the guard,
// not this matcher.
export function matchWorkGraph(path: string): string | null {
  const m = /^\/api\/work\/([^/]+)\/graph$/.exec(path);
  if (!m || m[1] === undefined) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null; // malformed percent-encoding — no match (falls through to 404 via no route)
  }
}

// Match `/api/work/:id/doc/:docId` → the decoded run + doc ids, or null. Same decode discipline as
// `matchWorkGraph`; the run/doc safety is the host-router/reader guard, not this matcher.
export function matchWorkDoc(path: string): { runId: string; docId: string } | null {
  const m = /^\/api\/work\/([^/]+)\/doc\/([^/]+)$/.exec(path);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  try {
    return { runId: decodeURIComponent(m[1]), docId: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}

// Match `/api/work/:id/review/:docId` → the decoded run + doc ids, or null. The doc id IS the gate key
// (the comment loop's gate == docId). Same decode discipline as `matchWorkDoc`; the run-segment safety is
// the store's `runDir`/`assertSafeSegment` guard, not this matcher.
export function matchWorkReview(path: string): { runId: string; docId: string } | null {
  const m = /^\/api\/work\/([^/]+)\/review\/([^/]+)$/.exec(path);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  try {
    return { runId: decodeURIComponent(m[1]), docId: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}

// Match a write path `/api/work/:id/{comment|resolve|artifact|takeover|status}` → its kind + the decoded
// run id, or null. The matcher only recognizes the shape; the verb gate + body parse happen in the dispatcher.
export function matchWritePath(path: string): { kind: WriteKind; runId: string } | null {
  const m = /^\/api\/work\/([^/]+)\/(comment|resolve|artifact|takeover|status)$/.exec(path);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  try {
    return { kind: m[2] as WriteKind, runId: decodeURIComponent(m[1]) };
  } catch {
    return null;
  }
}

// Match `/api/permissions/:request_id` → the decoded id, or null. The id is `decodeURIComponent`d so a
// percent-encoded value round-trips; the traversal safety is `assertSafeSegment` (in `writeVerdict`), not
// this matcher.
export function matchPermissionVerdict(path: string): string | null {
  const m = /^\/api\/permissions\/([^/]+)$/.exec(path);
  if (!m || m[1] === undefined) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null; // malformed percent-encoding — no match
  }
}
