// permission-reader — read + validate one FLOW permission REQUEST file (Phase 3b). The request file is
// untrusted input written by another process (FLOW's relay), so it is validated, never trusted: a
// malformed / half-written / partial file reads as `undefined` (the caller skips it; chokidar re-fires
// when the write completes), never a throw that would crash the watcher. The shape is FLOW's pinned
// `PermissionRequestFile` — the four relayed params + an ISO `created_at`; we project it to the shared
// `PermissionRequest` read-model (identical fields). Kept separate from the watcher so the parse is
// unit-testable without chokidar.
import { readFileSync } from "node:fs";
import type { PermissionRequest } from "@agentry/workbench-shared";

// Read + parse a `<request_id>.json` request file. Returns the `PermissionRequest` on a well-formed
// file, or `undefined` for anything that isn't (file vanished, bad JSON, a missing/non-string field).
export function readRequestFile(path: string): PermissionRequest | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined; // vanished between the watch event and the read
  }
  return parseRequestFile(raw);
}

// Validate raw request-file text into a `PermissionRequest`. Every field must be a present string (the
// pinned contract is five all-string fields). Anything off-contract is `undefined`.
export function parseRequestFile(raw: string): PermissionRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined; // not JSON (or a truncated half-write) — ignore
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const r = parsed as Record<string, unknown>;
  if (
    !isNonEmptyString(r.request_id) ||
    !isString(r.tool_name) ||
    !isString(r.description) ||
    !isString(r.input_preview) ||
    !isString(r.created_at)
  ) {
    return undefined;
  }
  return {
    request_id: r.request_id,
    tool_name: r.tool_name,
    description: r.description,
    input_preview: r.input_preview,
    created_at: r.created_at,
  };
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
