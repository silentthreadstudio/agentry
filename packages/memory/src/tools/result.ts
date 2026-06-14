// Shared tool-result helper — serialize a structured result as MCP text content.
export const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});
