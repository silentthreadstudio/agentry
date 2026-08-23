// BacklogService — the backlog lifecycle (doc 18 §3). Pure of MCP: it takes the file-store services and
// returns plain values the thin tool adapters serialize, mirroring RunService.
//
// It owns four things and no more: add, list, update, and CLAIM — the last being the one that matters,
// because claiming is where intent becomes work.
//
// THE HONESTY RULE (doc 18 §3.2). Nothing in this service starts an agent. `ready` is a QUEUE: it marks
// an item as available and stops. A conducting session claims it — that is the only path from intent to
// running work, and it exists so that nothing starts work the user did not start. The Workbench has no
// model and cannot dispatch; a "Start now" that silently spawned something would be a lie in the UI.
import { BacklogItem, BacklogStatus, isReady, mintBacklogId } from "../domain/backlog.js";
import type { BacklogStore } from "../domain/ports.js";
import type { RunService } from "./run-service.js";

export interface AddInput {
  title: string;
  body?: string;
  kind?: string;
  /** Create it already queued for the conductor (the composer's "Queue for the conductor"). */
  ready?: boolean;
}

export interface UpdateInput {
  id: string;
  title?: string;
  body?: string;
  kind?: string;
  status?: BacklogStatus;
}

export type ClaimOutcome =
  | { ok: true; item: BacklogItem; run: string }
  | { ok: false; reason: "not_found" | "not_ready" | "empty_queue" };

export class BacklogService {
  constructor(
    private readonly store: BacklogStore,
    private readonly runs: RunService,
    private readonly now: () => string,
  ) {}

  add(input: AddInput): BacklogItem {
    const ts = this.now();
    const item = BacklogItem.parse({
      id: mintBacklogId(input.title),
      title: input.title,
      kind: input.kind ?? "feature",
      status: input.ready === true ? "ready" : "backlog",
      createdAt: ts,
      updatedAt: ts,
      runs: [],
      body: input.body ?? "",
    });
    this.store.write(item);
    return item;
  }

  list(status?: BacklogStatus): BacklogItem[] {
    const all = this.store.list();
    return status === undefined ? all : all.filter((i) => i.status === status);
  }

  /** Patch an item. Absent fields are left alone — this is a patch, not a replace, so a caller that
   *  knows only the new status cannot accidentally blank the body. */
  update(input: UpdateInput): BacklogItem | undefined {
    const current = this.store.read(input.id);
    if (!current) return undefined;
    const next = BacklogItem.parse({
      ...current,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: this.now(),
    });
    this.store.write(next);
    return next;
  }

  /**
   * Take an item and mint its run — the intent→work transition, and the ONLY one.
   *
   * With no id, claims the oldest READY item (the queue is FIFO: the thing that has waited longest goes
   * first, which is what a queue means and what `/agentry:go` with no argument expects). The run is
   * minted through the existing `RunService.start`, so a claimed run is indistinguishable from one a
   * session started directly — same id shape, same scaffold, same layout.
   */
  claim(id?: string, sessionId?: string): ClaimOutcome {
    let item: BacklogItem | undefined;
    if (id !== undefined && id.length > 0) {
      item = this.store.read(id);
      if (!item) return { ok: false, reason: "not_found" };
      if (!isReady(item)) return { ok: false, reason: "not_ready" };
    } else {
      const queue = this.list("ready").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      item = queue[0];
      if (!item) return { ok: false, reason: "empty_queue" };
    }

    const { run } = this.runs.start({
      goal: item.title,
      ...(sessionId !== undefined && sessionId.length > 0 ? { session_id: sessionId } : {}),
    });
    const claimed = BacklogItem.parse({
      ...item,
      status: "claimed",
      runs: [...item.runs, run],
      updatedAt: this.now(),
    });
    this.store.write(claimed);
    return { ok: true, item: claimed, run };
  }
}
