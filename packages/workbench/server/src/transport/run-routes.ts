// run-routes — starting new work from the Workbench.
//
//   POST /api/runs            { goal }  → { run }
//   POST /api/work/:id/reset            → { ok, tasks }   — put a run's work back on the shelf
//
// A separate dispatcher from the run-SCOPED write surface (`write-routes`, everything under
// `/api/work/:id/…`) because this one has no run yet — it makes one. Same shape as the other
// dispatchers: it claims its path or returns false so the ladder continues.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunStarter } from "../persistence/run-starter.js";
import type { Transport } from "../domain/ports.js";
import { resolveSlug } from "@agentry/workbench-shared";
import { readJsonBody, sendJson } from "./http-kit.js";

export interface RunStartDeps {
  starter: RunStarter;
  transport: Transport;
}

/** What a reset needs: the run's tasks (to know what to put back), the write boundary, and the backlog
 *  (to hand the intent back). Typed structurally so a test needs three small fakes, not the world. */
export interface ResetDeps {
  reader: { read(run: string): { docs: { id: string }[] } | undefined; listRuns(): string[] };
  writeService: { setStatus(req: { run: string; taskNo: string; status: "todo" }): { ok: boolean } };
  backlog: {
    list(): { id: string; runs: string[]; status: string }[];
    update(input: { id: string; status: "ready" }): unknown;
  };
  transport: Transport;
}

const RESET_PATH = /^\/api\/work\/([^/]+)\/reset$/;

/**
 * Put a run's work back on the shelf: every task returns to `todo`, and the backlog item that spawned
 * it (if any) returns to `ready` so it can be claimed again.
 *
 * RESET, NOT CANCEL — the decision recorded in doc 18 Q2. It kills nothing: an agent writing right now
 * keeps writing, and the run, its artifacts and its history are all preserved. Killing a live agent
 * mid-write is a far riskier operation than a drag on a board should ever mean, so it is neither what
 * this does nor what the board offers.
 */
export async function handleRunResetRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ResetDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = RESET_PATH.exec(url.pathname);
  if (match === null) return false;
  if ((req.method ?? "GET") !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }

  let label: string;
  try {
    label = decodeURIComponent(match[1] ?? "");
  } catch {
    sendJson(res, 400, { error: "bad_run" });
    return true;
  }

  const run = resolveSlug(label, deps.reader.listRuns());
  const read = run !== undefined ? deps.reader.read(run) : undefined;
  if (run === undefined || read === undefined) {
    sendJson(res, 404, { error: "unknown_run" });
    return true;
  }

  const taskNos = read.docs.filter((d) => d.id.startsWith("task-")).map((d) => d.id.slice("task-".length));
  let reset = 0;
  for (const taskNo of taskNos) {
    if (deps.writeService.setStatus({ run, taskNo, status: "todo" }).ok) reset += 1;
  }

  // The item that spawned this run goes back to `ready`, not `backlog`: it was queued once, and nothing
  // about resetting the run says you changed your mind about wanting the work.
  const item = deps.backlog.list().find((i) => i.runs.includes(run));
  if (item !== undefined) deps.backlog.update({ id: item.id, status: "ready" });

  deps.transport.pushAll({ type: "works-changed" });
  sendJson(res, 200, { ok: true, run, tasks: reset, ...(item !== undefined ? { item: item.id } : {}) });
  return true;
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
