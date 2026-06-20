// Tests for the comment-store's on-disk hydrate (the bidirectional AI↔Dashboard loop, VISION §6). The
// store is module-level state keyed by `${runId} ${docId}`, so each test uses a UNIQUE run/doc key to stay
// isolated (no shared-state bleed between cases). We assert the merge behavior the rail depends on: on-disk
// comments seed the store, session comments win on an id clash (keeping their `mine` flag), and the open
// count reflects the merged set — the badge's signal.
import assert from "node:assert/strict";
import test from "node:test";
import {
  addComment,
  hydrate,
  openCommentCount,
  snapshotForTest,
} from "../routes/work/live/doc/comment-store.js";
import type { DiskComment } from "../routes/work/live/doc/comment-store.js";

const anchor = { originalText: "x", headingAnchor: "h", startLine: 1 };
const disk = (id: string, resolved = false): DiskComment => ({
  id,
  anchor,
  decision: "changes",
  body: `body-${id}`,
  resolved,
});

test("hydrate seeds an empty store with on-disk comments (mine = false)", () => {
  const [runId, docId] = ["run-hydrate-1", "spec"];
  hydrate(runId, docId, [disk("c1"), disk("c2")]);
  const list = snapshotForTest(runId, docId);
  assert.equal(list.length, 2, "both disk comments seeded");
  assert.equal(list.every((c) => c.mine === false), true, "seeded comments are not 'mine'");
});

test("hydrate counts an open disk comment in the badge signal", () => {
  const [runId, docId] = ["run-hydrate-2", "spec"];
  hydrate(runId, docId, [disk("c1", false), disk("c2", true)]);
  assert.equal(openCommentCount(runId, docId), 1, "one open, one resolved → count 1");
});

test("hydrate is idempotent — re-hydrating the same disk set does not duplicate", () => {
  const [runId, docId] = ["run-hydrate-3", "spec"];
  hydrate(runId, docId, [disk("c1")]);
  hydrate(runId, docId, [disk("c1")]);
  assert.equal(snapshotForTest(runId, docId).length, 1, "no duplicate on re-hydrate");
});

test("returns empty for a doc that was never hydrated", () => {
  assert.equal(snapshotForTest("run-hydrate-unknown", "plan").length, 0);
});

test("a session comment wins over a disk comment with the same id (keeps `mine`, no dup)", async () => {
  const [runId, docId] = ["run-hydrate-4", "spec"];
  // Stub fetch so addComment's POST mints a known id and inserts a session comment (mine: true).
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({ ok: true, json: async () => ({ id: "shared" }) }) as Response) as typeof fetch;
  try {
    const added = await addComment({ runId, docId, anchor, decision: "approve", body: "session" });
    assert.equal(added.ok, true);
  } finally {
    globalThis.fetch = realFetch;
  }

  // The disk read returns the SAME id (the POST already landed on disk) plus a fresh one.
  hydrate(runId, docId, [disk("shared"), disk("other")]);
  const list = snapshotForTest(runId, docId);
  assert.equal(list.length, 2, "shared id de-duped — session + the one new disk comment");
  const shared = list.find((c) => c.id === "shared");
  assert.equal(shared?.mine, true, "the session comment's `mine` flag survives the merge");
  assert.equal(shared?.body, "session", "the session version (not the disk one) is kept");
});
