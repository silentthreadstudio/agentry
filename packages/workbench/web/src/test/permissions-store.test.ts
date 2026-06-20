// permissions-store — the approvals-banner pending-list fold (Phase 3b). Covers the reducer's real edges:
// add appends, a re-emit of the same id dedups (upsert in place, no reorder), remove drops by id, an
// unknown remove is a no-op (same reference), a non-permission message passes through, and mergeSnapshot
// dedups a reconnect snapshot.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionRequest, WsMessage } from "@agentry/workbench-shared";
import { applyPermissionMessage, mergeSnapshot } from "../routes/permissions-store.js";

function req(id: string, over: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    request_id: id,
    tool_name: "Bash",
    description: "do a thing",
    input_preview: "{}",
    created_at: "2026-06-19T00:00:00.000Z",
    ...over,
  };
}

const added = (request: PermissionRequest): WsMessage => ({ type: "permission-added", request });
const removed = (requestId: string): WsMessage => ({ type: "permission-removed", requestId });

test("permission-added appends a new request", () => {
  const next = applyPermissionMessage([], added(req("aaaaa")));
  assert.deepEqual(next.map((r) => r.request_id), ["aaaaa"]);
});

test("permission-added with a known id upserts in place (dedup, no duplicate, no reorder)", () => {
  const start = [req("aaaaa"), req("bbbbb")];
  const next = applyPermissionMessage(start, added(req("aaaaa", { description: "updated" })));
  assert.deepEqual(next.map((r) => r.request_id), ["aaaaa", "bbbbb"], "no duplicate, order preserved");
  assert.equal(next[0]?.description, "updated", "the existing entry was replaced in place");
});

test("permission-removed drops the request by id", () => {
  const start = [req("aaaaa"), req("bbbbb")];
  const next = applyPermissionMessage(start, removed("aaaaa"));
  assert.deepEqual(next.map((r) => r.request_id), ["bbbbb"]);
});

test("permission-removed for an unknown id is a no-op (same reference — no re-render)", () => {
  const start = [req("aaaaa")];
  const next = applyPermissionMessage(start, removed("zzzzz"));
  assert.equal(next, start, "the same array reference is returned");
});

test("a non-permission message passes the list through unchanged", () => {
  const start = [req("aaaaa")];
  const next = applyPermissionMessage(start, { type: "file-changed", path: "spec.md" });
  assert.equal(next, start);
});

test("stacking multiple distinct requests keeps them all, oldest first", () => {
  let list: PermissionRequest[] = [];
  list = applyPermissionMessage(list, added(req("aaaaa")));
  list = applyPermissionMessage(list, added(req("bbbbb")));
  list = applyPermissionMessage(list, added(req("ccccc")));
  assert.deepEqual(list.map((r) => r.request_id), ["aaaaa", "bbbbb", "ccccc"]);
});

test("mergeSnapshot dedups a reconnect snapshot by id", () => {
  const merged = mergeSnapshot([req("aaaaa"), req("aaaaa"), req("bbbbb")]);
  assert.deepEqual(merged.map((r) => r.request_id), ["aaaaa", "bbbbb"]);
});
