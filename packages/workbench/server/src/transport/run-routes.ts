// run-routes — run-level writes that are not doc edits.
//
//   POST /api/work/:id/reset  → { ok, tasks }   — put a run's work back on the shelf
//
// There is deliberately no route that CREATES a run. The board creates backlog items, and a run comes
// from a session claiming one (doc 18 §3.2): the Workbench has no model, cannot dispatch, and an
// endpoint that minted a run from the dashboard would be a second way to start work carrying none of
// the claim path's meaning. `POST /api/runs` existed briefly in slice 2 and was removed with it.
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveSlug } from "@agentry/workbench-shared";
import type { Transport } from "../domain/ports.js";
import { sendJson } from "./http-kit.js";

/** What a reset needs: the run's tasks (to know what to put back), the write boundary, and the backlog
 *  (to hand the intent back). Typed structurally so a test needs three small fakes, not the world. */
export interface ResetDeps {
  reader: { read(run: string): { docs: { id: string }[] } | undefined; listRuns(): string[] };
  writeService: {
    setStatus(req: { run: string; taskNo: string; status: "todo" }): { ok: boolean };
  };
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

  const taskNos = read.docs
    .filter((d) => d.id.startsWith("task-"))
    .map((d) => d.id.slice("task-".length));
  let reset = 0;
  for (const taskNo of taskNos) {
    if (deps.writeService.setStatus({ run, taskNo, status: "todo" }).ok) reset += 1;
  }

  // The item that spawned this run goes back to `ready`, not `backlog`: it was queued once, and nothing
  // about resetting the run says you changed your mind about wanting the work.
  const item = deps.backlog.list().find((i) => i.runs.includes(run));
  if (item !== undefined) deps.backlog.update({ id: item.id, status: "ready" });

  deps.transport.pushAll({ type: "works-changed" });
  sendJson(res, 200, {
    ok: true,
    run,
    tasks: reset,
    ...(item !== undefined ? { item: item.id } : {}),
  });
  return true;
}
