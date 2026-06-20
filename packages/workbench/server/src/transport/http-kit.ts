// http-kit — the transport primitives every dispatcher shares (ADR-001's `transport` edge). Pure HTTP
// plumbing: JSON serialization, the GET guard, the untrusted-body record guard, the bounded JSON body
// reader, and the `{ error }` envelope helper. No route knowledge lives here — the dispatchers in
// `read-routes`/`reader-routes`/`write-routes`/`permission-routes` compose these to map a typed outcome
// onto an HTTP response.
import type { IncomingMessage, ServerResponse } from "node:http";

// Only GET is served on the read surface; a write verb to a known read path is 405, not a silent 404.
// Returns true — the request was handled either way.
export function guardGet(method: string, res: ServerResponse, run: () => void): boolean {
  if (method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  run();
  return true;
}

// A plain-object guard for untrusted request bodies (rejects null/array/primitive).
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Send an `{ error }` envelope (+ optional extra fields like `lockedBy`/`currentVersion`) and return
// true — the request was handled. The single error-shape helper for the write surface.
export function reject(
  res: ServerResponse,
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
): boolean {
  sendJson(res, status, { error, ...extra });
  return true;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// Read + JSON-parse the request body, capping it so a hostile client can't exhaust memory (the local
// write payloads are small markdown bodies). An empty body parses to `{}` (a bodyless POST is a 400 at
// the field checks, not here). Rejects (throws) on overflow or malformed JSON — the dispatcher maps it
// to 400.
export const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB — generous for a doc body, bounded against abuse.
export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, rejectPromise) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text.length === 0) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        rejectPromise(new Error("invalid_json"));
      }
    });
    req.on("error", rejectPromise);
  });
}
