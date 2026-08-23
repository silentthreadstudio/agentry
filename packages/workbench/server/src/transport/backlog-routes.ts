// backlog-routes — the project's backlog surface (doc 18 slice 1).
//
//   GET  /api/backlog[?status=]  → { items }
//   POST /api/backlog            { title, body?, kind?, ready? } → the created item
//   POST /api/backlog/:id        { title?, body?, kind?, status? } → the patched item
//
// Note what is NOT here: claiming. Minting a run from an item is a session's move, not the dashboard's
// (doc 18 §3.2) — the Workbench has no model and must not appear to start work. `backlog_claim` is an
// MCP tool a conductor calls; there is deliberately no HTTP route that does it.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BacklogAdapter } from "../persistence/backlog-adapter.js";
import { guardGet, readJsonBody, sendJson } from "./http-kit.js";

export interface BacklogDeps {
  backlog: BacklogAdapter;
  transport: { pushAll(message: { type: "works-changed" }): void };
}

const ITEM_PATH = /^\/api\/backlog\/([^/]+)$/;

/** Whether the dispatcher answered. Async because the write paths consume the body. */
export async function handleBacklogRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: BacklogDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";

  if (url.pathname === "/api/backlog") {
    if (method === "GET") {
      const status = url.searchParams.get("status") ?? undefined;
      return guardGet(method, res, () =>
        sendJson(res, 200, { items: deps.backlog.service.list(status as never) }),
      );
    }
    if (method === "POST") {
      const body = asRecord(await readJsonBody(req));
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (title.length === 0) {
        sendJson(res, 400, { error: "missing_title" });
        return true;
      }
      const item = deps.backlog.service.add({
        title,
        ...(typeof body.body === "string" ? { body: body.body } : {}),
        ...(typeof body.kind === "string" ? { kind: body.kind } : {}),
        ...(body.ready === true ? { ready: true } : {}),
      });
      deps.transport.pushAll({ type: "works-changed" }); // the board is live for every open client
      sendJson(res, 200, item);
      return true;
    }
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const match = ITEM_PATH.exec(url.pathname);
  if (match === null) return false;
  if (method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  let id: string;
  try {
    id = decodeURIComponent(match[1] ?? "");
  } catch {
    sendJson(res, 400, { error: "bad_id" });
    return true;
  }

  const body = asRecord(await readJsonBody(req));
  const item = deps.backlog.service.update({
    id,
    ...(typeof body.title === "string" ? { title: body.title } : {}),
    ...(typeof body.body === "string" ? { body: body.body } : {}),
    ...(typeof body.kind === "string" ? { kind: body.kind } : {}),
    ...(typeof body.status === "string" ? { status: body.status as never } : {}),
  });
  if (!item) {
    sendJson(res, 404, { error: "unknown_item" });
    return true;
  }
  deps.transport.pushAll({ type: "works-changed" });
  sendJson(res, 200, item);
  return true;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
