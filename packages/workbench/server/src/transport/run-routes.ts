// run-routes — starting new work from the Workbench.
//
//   POST /api/runs  { goal }  → { run }
//
// A separate dispatcher from the run-SCOPED write surface (`write-routes`, everything under
// `/api/work/:id/…`) because this one has no run yet — it makes one. Same shape as the other
// dispatchers: it claims its path or returns false so the ladder continues.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunStarter } from "../persistence/run-starter.js";
import type { Transport } from "../domain/ports.js";
import { readJsonBody, sendJson } from "./http-kit.js";

export interface RunStartDeps {
  starter: RunStarter;
  transport: Transport;
}

/** Whether the dispatcher answered. Async because it consumes the body (mirrors handlePostRequest). */
export async function handleRunStartRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RunStartDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/runs") return false;
  if ((req.method ?? "GET") !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  const body = await readJsonBody(req);
  const goal = typeof body === "object" && body !== null ? (body as { goal?: unknown }).goal : undefined;
  if (typeof goal !== "string" || goal.trim().length === 0) {
    sendJson(res, 400, { error: "missing_goal" });
    return true;
  }

  const { run } = deps.starter.start(goal.trim());
  // A new run changes the Works list for every open client. The run-tree watcher fires too, but only
  // once its debounce lands — this makes the card appear immediately, which is what "New work" promises.
  deps.transport.pushAll({ type: "works-changed" });
  sendJson(res, 200, { run });
  return true;
}
