// Shared tool-result helper — serialize a structured result as MCP text content.
import type { MemoryError } from "@agentry/core";

export const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});

// Serialize a structured error envelope as an MCP error response (ADR-001 §A). The envelope is nested
// under a top-level `error` key so success and error payloads never collide; `isError:true` flags the
// failure to the SDK. Carries only the envelope — no file path, no stack frame (AC7).
export const err = (envelope: MemoryError) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error: envelope }) }],
  isError: true as const,
});
