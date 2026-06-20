// Tests for the Phase 2b human/agent-reply split (the threaded conversation rail). `threadsOf` turns a
// doc's flat comment list into human top-level threads with their agent replies nested under `replyTo`,
// and `openCommentCount` must count unresolved HUMAN comments only (agent replies are display-only). The
// store is module state keyed by `${runId} ${docId}`, so the count cases use a UNIQUE run/doc per test.
import assert from "node:assert/strict";
import test from "node:test";
import {
  hydrate,
  openCommentCount,
  threadsOf,
  type UiComment,
} from "../routes/work/live/doc/comment-store.js";
import type { DiskComment } from "../routes/work/live/doc/comment-store.js";

const anchor = { originalText: "x", headingAnchor: "h", startLine: 1 };

function human(id: string, resolved = false): UiComment {
  return { id, anchor, decision: "changes", body: `human-${id}`, resolved, mine: false };
}
function reply(id: string, replyTo?: string): UiComment {
  return {
    id,
    anchor,
    decision: "changes",
    body: `reply-${id}`,
    resolved: true,
    mine: false,
    origin: "agent",
    ...(replyTo !== undefined ? { replyTo } : {}),
  };
}

test("threadsOf nests an agent reply under the human comment its replyTo points at", () => {
  const { threads, orphanReplies } = threadsOf([human("c1"), reply("r1", "c1")]);
  assert.equal(threads.length, 1, "one human thread");
  assert.equal(threads[0]?.comment.id, "c1");
  assert.equal(threads[0]?.replies.length, 1, "the reply nests under its parent");
  assert.equal(threads[0]?.replies[0]?.id, "r1");
  assert.equal(orphanReplies.length, 0, "no orphans");
});

test("threadsOf treats an absent-origin comment as a human top-level thread", () => {
  // origin absent ⇒ human (back-compat with pre-Phase-2 sidecars), so it must be a top-level thread.
  const { threads } = threadsOf([human("c1")]);
  assert.equal(threads.length, 1);
  assert.equal(threads[0]?.replies.length, 0);
});

test("threadsOf keeps human comments in store order (newest-first preserved)", () => {
  const { threads } = threadsOf([human("c2"), human("c1")]);
  assert.deepEqual(
    threads.map((t) => t.comment.id),
    ["c2", "c1"],
    "thread order follows the input list order, not re-sorted",
  );
});

test("threadsOf treats a comment with no replyTo as a thread root (threading keys on replyTo, not origin)", () => {
  // A reply ALWAYS carries replyTo (channel_reply sets it); a comment without one is a root regardless of
  // origin. So a stray no-replyTo entry becomes its own top-level thread, never an orphan.
  const { threads, orphanReplies } = threadsOf([human("c1"), reply("r1")]);
  assert.equal(threads.length, 2, "both no-replyTo comments are roots");
  assert.equal(orphanReplies.length, 0, "nothing is orphaned — orphans come from an unknown replyTo");
});

test("threadsOf routes a reply pointing at an unknown id to orphanReplies", () => {
  const { threads, orphanReplies } = threadsOf([human("c1"), reply("r1", "no-such-comment")]);
  assert.equal(threads[0]?.replies.length, 0);
  assert.equal(orphanReplies.length, 1, "a replyTo that matches no human comment is an orphan");
});

test("threadsOf nests multiple replies under one comment, preserving insertion order", () => {
  const { threads } = threadsOf([human("c1"), reply("r1", "c1"), reply("r2", "c1")]);
  assert.deepEqual(
    threads[0]?.replies.map((r) => r.id),
    ["r1", "r2"],
    "both replies nest under the same parent in order",
  );
});

test("openCommentCount counts unresolved HUMAN comments only (agent replies excluded)", () => {
  const [runId, docId] = ["run-thread-count-1", "spec"];
  // One open human comment + one agent reply (unresolved would be malformed, but assert it's excluded
  // regardless): the badge must read 1, not 2.
  const disk: DiskComment[] = [
    { id: "c1", anchor, decision: "changes", body: "open", resolved: false },
    { id: "r1", anchor, decision: "changes", body: "reply", resolved: false, origin: "agent", replyTo: "c1" },
  ];
  hydrate(runId, docId, disk);
  assert.equal(openCommentCount(runId, docId), 1, "only the human comment counts toward the badge");
});

test("openCommentCount ignores a resolved human comment and any agent reply", () => {
  const [runId, docId] = ["run-thread-count-2", "spec"];
  const disk: DiskComment[] = [
    { id: "c1", anchor, decision: "approve", body: "done", resolved: true },
    { id: "r1", anchor, decision: "changes", body: "reply", resolved: true, origin: "agent", replyTo: "c1" },
  ];
  hydrate(runId, docId, disk);
  assert.equal(openCommentCount(runId, docId), 0, "resolved human + agent reply → badge 0");
});
