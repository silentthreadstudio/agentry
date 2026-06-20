// Permission-relay — the PURE half of the permission relay (channels.md "Relay permission prompts",
// Phase 3a). No I/O: the zod schemas for the two custom notifications, the on-disk request/verdict
// file shapes, and the parse/validate helpers. The relay (infra) owns the notification handler + the
// verdict watcher + the fs writes + the pending set; this module owns the wire shapes + the decision
// of what counts as a valid verdict, so it's unit-testable without chokidar, fs, or the SDK.
//
// The flow: Claude Code sends `notifications/claude/channel/permission_request` when a tool needs
// approval → the relay writes `<request_id>.json` + tracks the id pending → the Workbench writes
// `<request_id>.verdict.json` → the relay emits `notifications/claude/channel/permission` with the
// verdict and deletes both files. First answer wins (the local terminal stays live); Claude Code
// drops a verdict whose id it doesn't recognize, so emitting a stale/unknown verdict is harmless —
// but the relay still only emits for ids it actually issued (the pending set), per the file contract.
import { z } from "zod";

// The outbound notification Claude Code sends on a permission prompt. `setNotificationHandler` routes
// by the `z.literal` method, so this schema is both the validator and the dispatch key (channels.md).
// The four params are all strings; we relay them verbatim into the request file.
export const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(), // five lowercase letters (a-z, no 'l') — echoed verbatim in the verdict
    tool_name: z.string(), // e.g. "Bash", "Write"
    description: z.string(), // human-readable summary of this specific call
    input_preview: z.string(), // tool args as JSON, truncated to ~200 chars by Claude Code
  }),
});

// The behavior a verdict carries — `allow` lets the tool proceed, `deny` rejects it (== "No" in the
// local dialog). Mirrors channels.md's two-value verdict.
export const PermissionBehaviorSchema = z.enum(["allow", "deny"]);
export type PermissionBehavior = z.infer<typeof PermissionBehaviorSchema>;

// The request file flow WRITES at `<dir>/<request_id>.json` on a permission_request. Pinned shape —
// Phase 3b's Workbench reads it verbatim: the four relayed params + an ISO `created_at` stamp.
export interface PermissionRequestFile {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
  created_at: string; // ISO 8601
}

// The verdict file the Workbench WRITES at `<dir>/<request_id>.verdict.json`. Pinned shape — flow
// reads it verbatim: the echoed id + the human's behavior. Validated on read (the file is untrusted
// input from another process; a malformed one is ignored, never thrown).
const PermissionVerdictFileSchema = z.object({
  request_id: z.string(),
  behavior: PermissionBehaviorSchema,
});
export type PermissionVerdictFile = z.infer<typeof PermissionVerdictFileSchema>;

// The verdict notification flow EMITS back to Claude Code when a pending request gets a verdict.
export interface PermissionVerdictNotification {
  method: "notifications/claude/channel/permission";
  params: { request_id: string; behavior: PermissionBehavior };
}

// Build the request-file record from a validated permission_request's params + a created-at stamp.
// `created_at` is injected (not read from the clock here) so the pure shape stays deterministic.
export function buildRequestFile(
  params: { request_id: string; tool_name: string; description: string; input_preview: string },
  createdAt: string,
): PermissionRequestFile {
  return {
    request_id: params.request_id,
    tool_name: params.tool_name,
    description: params.description,
    input_preview: params.input_preview,
    created_at: createdAt,
  };
}

// Parse + validate a verdict file's raw text. Returns the verdict on a well-formed file, or undefined
// for anything malformed (bad JSON, missing fields, an unknown behavior) — the caller ignores an
// undefined and never throws, so a stray/corrupt `.verdict.json` can't crash the watcher.
export function parseVerdictFile(raw: string): PermissionVerdictFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined; // not JSON — ignore
  }
  const result = PermissionVerdictFileSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

// Decide what to do with a verdict for a given request_id against the pending set. Emits the verdict
// notification ONLY for an id flow actually issued (in `pending`) — a verdict for an unknown/stale id
// yields no notification (channels.md: Claude Code would drop it anyway, but we don't even emit). The
// `<request_id>.verdict.json` is the Workbench's filename; the `request_id` INSIDE the file is the
// authority (we key off the parsed id), so a mismatched filename can't spoof a different request.
export function resolveVerdict(
  verdict: PermissionVerdictFile,
  pending: ReadonlySet<string>,
): PermissionVerdictNotification | undefined {
  if (!pending.has(verdict.request_id)) return undefined; // unknown/stale id — don't emit
  return {
    method: "notifications/claude/channel/permission",
    params: { request_id: verdict.request_id, behavior: verdict.behavior },
  };
}
