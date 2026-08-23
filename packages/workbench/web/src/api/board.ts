// GET /api/board → every item and run in this project, already folded into columns.
//
// The fold happens server-side on purpose (doc 18 AC4): a client that derived the column from a task
// tally could disagree with disk the moment either side moved, and two views of one run disagreeing is
// the failure this endpoint exists to prevent. The client renders what it is given.
import type { BoardModel } from "@agentry/workbench-shared";
import { getJson } from "./http.js";

export function fetchBoard(signal?: AbortSignal): Promise<BoardModel> {
  return getJson<BoardModel>("/api/board", signal);
}
