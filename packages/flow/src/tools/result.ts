// Shared tool-result helper — serialize a structured result as MCP text content. Mirrors
// @agentry/memory's tools/result.ts (same envelope shape, FLOW's own error type).
import type { FlowError } from "./errors.js";

export const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});

// Serialize a structured error envelope as an MCP error response. The envelope is nested under a
// top-level `error` key so success and error payloads never collide; `isError:true` flags the
// failure to the SDK. Carries only the envelope — no file path, no stack frame.
export const err = (envelope: FlowError) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error: envelope }) }],
  isError: true as const,
});
