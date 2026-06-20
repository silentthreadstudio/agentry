// GET /api/work/:id/review/:docId → one doc's on-disk review comments (the comment-rail hydrate, VISION
// §6). The docId IS the gate key (the SAME id the /comment POST writes under). Returns [] for a doc with
// no comments yet. `ReviewComment` is projected off the shared `GateItem.comments` (no new import).
import type { GateItem } from "@agentry/workbench-shared";
import { getJson } from "./http.js";

export type ReviewComment = GateItem["comments"][number];

export function fetchReview(
  runId: string,
  docId: string,
  signal?: AbortSignal,
): Promise<ReviewComment[]> {
  return getJson<ReviewComment[]>(
    `/api/work/${encodeURIComponent(runId)}/review/${encodeURIComponent(docId)}`,
    signal,
  );
}
