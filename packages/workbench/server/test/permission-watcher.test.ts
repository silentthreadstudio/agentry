// PermissionWatcher.prunePhantoms — the self-heal that keeps GET /api/permissions disk-truthful. chokidar
// can miss the `unlink` for a request file created+deleted within milliseconds (the auto-approve case),
// leaving a phantom in the pending map; prunePhantoms drops any whose file is gone. Tested purely with a
// fake existence probe (no chokidar timing).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionRequest } from "@agentry/workbench-shared";
import { prunePhantoms } from "../src/persistence/permission-watcher.js";

function req(id: string): PermissionRequest {
  return { request_id: id, tool_name: "Bash", description: "", input_preview: "", created_at: "t" };
}

test("prunePhantoms drops pending entries whose file is gone, returns their ids", () => {
  const pending = new Map([
    ["a", req("a")],
    ["b", req("b")],
    ["c", req("c")],
  ]);
  // b's request file vanished (a missed unlink); a and c still exist.
  const removed = prunePhantoms(pending, (id) => id !== "b");
  assert.deepEqual(removed, ["b"]);
  assert.deepEqual([...pending.keys()], ["a", "c"], "the phantom is pruned; the live ones stay");
});

test("prunePhantoms is a no-op when every file still exists", () => {
  const pending = new Map([["a", req("a")]]);
  assert.deepEqual(prunePhantoms(pending, () => true), []);
  assert.equal(pending.size, 1);
});

test("prunePhantoms clears all when the dir emptied (every file gone)", () => {
  const pending = new Map([
    ["a", req("a")],
    ["b", req("b")],
  ]);
  assert.deepEqual(prunePhantoms(pending, () => false).sort(), ["a", "b"]);
  assert.equal(pending.size, 0);
});
