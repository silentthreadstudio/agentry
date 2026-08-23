// BacklogItem — durable intent that has not become a run yet (doc 18 §3.1). Pure zod + pure helpers,
// no I/O.
//
// WHY THIS EXISTS. Until now work existed only once a run started, so "we should do this" died with the
// session that had it. This is the one durable concept the workspace adds — and deliberately the only
// one: everything after `ready` is already modelled by a run and its tasks.
//
// WHY A SEPARATE STATUS FROM THE RUN'S. An item can be `claimed` while its run is still in-progress, and
// a run can be abandoned without the intent dying. Folding the two together would make "the run failed,
// the work still matters" unrepresentable — which is exactly the state a backlog exists to hold.
import { z } from "zod";
import { assertSafeSegment } from "./ids.js";

/** The ITEM's lifecycle — not the run's. `claimed` means a session took it and minted a run. */
export const BacklogStatus = z.enum(["backlog", "ready", "claimed", "done"]);
export type BacklogStatus = z.infer<typeof BacklogStatus>;

export const BacklogItem = z.object({
  id: z.string(),
  title: z.string(),
  /** Permissive on purpose, mirroring `Kind` in @agentry/core: accept an unknown kind rather than
   *  reject it, so adding one later cannot throw on an old record. */
  kind: z.string().default("feature"),
  status: BacklogStatus.default("backlog"),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Runs spawned from this item — usually 0 or 1, but a re-run appends rather than replaces. */
  runs: z.array(z.string()).default([]),
  /** The context an agent starts from: markdown, `@task-…` / `@memory:…` references. */
  body: z.string().default(""),
});
export type BacklogItem = z.infer<typeof BacklogItem>;

const STEM_WORDS = 3;
const STEM_MAX = 20;

// The same slug+suffix shape `mintRun` uses, so an item id and a run id read as siblings rather than as
// two different id systems. The `b-` prefix is what makes an item id recognisable at a glance in a file
// listing, a log line, or a URL.
function slug(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, STEM_WORDS);
  while (words.length > 1 && words.join("-").length > STEM_MAX) words.pop();
  return words.join("-").slice(0, STEM_MAX).replace(/-+$/g, "");
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

/** Mint an item id from its title: `b-<slug>-<shortid>`, a single traversal-safe path segment (it
 *  becomes a filename). A title that slugs to nothing falls back to a bare stem. */
export function mintBacklogId(title: string): string {
  const id = `b-${slug(title) || "item"}-${shortId()}`;
  assertSafeSegment(id);
  return id;
}

/** Whether an item is waiting for a conductor to take it. The queue `backlog_claim` reads. */
export function isReady(item: BacklogItem): boolean {
  return item.status === "ready";
}
