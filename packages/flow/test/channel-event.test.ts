// Channel-event — the PURE diff/meta logic of the comment→push bridge (no I/O). Proves: a new
// unresolved comment yields one notification with the right content + snake_case meta; resolved and
// already-seen comments yield nothing; ordering is preserved; the anchor quote is included.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewComment } from "../src/domain/review.js";
import { commentIds, diffNewComments, isPushable, renderChannelContent } from "../src/channel/channel-event.js";

function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: "c1",
    anchor: { originalText: "the auth guard", headingAnchor: "## Auth", startLine: 12 },
    decision: "changes",
    body: "tighten this",
    resolved: false,
    ...over,
  };
}

test("a new unresolved comment yields one notification", () => {
  const { notifications, newlySeen } = diffNewComments("run-x", "spec", [comment()], new Set());
  assert.equal(notifications.length, 1);
  assert.deepEqual(newlySeen, ["c1"]);
});

test("notification content quotes the anchor and carries the body", () => {
  const { notifications } = diffNewComments("run-x", "spec", [comment()], new Set());
  assert.equal(notifications[0].content, 'Review on "the auth guard": tighten this');
});

test("meta carries run/doc/comment_id/decision with snake_case keys only", () => {
  const { notifications } = diffNewComments("run-x", "spec", [comment({ id: "abc", decision: "question" })], new Set());
  const meta = notifications[0].meta;
  // exact key set — no hyphenated keys (the host drops them)
  assert.deepEqual(Object.keys(meta).sort(), ["comment_id", "decision", "doc", "run_id"]);
  assert.deepEqual(meta, { run_id: "run-x", doc: "spec", comment_id: "abc", decision: "question" });
});

test("a resolved comment yields no notification", () => {
  const { notifications, newlySeen } = diffNewComments("run-x", "spec", [comment({ resolved: true })], new Set());
  assert.equal(notifications.length, 0);
  assert.deepEqual(newlySeen, []);
});

test("an already-seen comment yields no notification (at-most-once)", () => {
  const seen = new Set(["c1"]);
  const { notifications, newlySeen } = diffNewComments("run-x", "spec", [comment()], seen);
  assert.equal(notifications.length, 0);
  assert.deepEqual(newlySeen, []);
});

test("only the new comments in a mixed sidecar push, in order", () => {
  const comments = [
    comment({ id: "old", body: "already pushed" }),
    comment({ id: "done", resolved: true, body: "resolved" }),
    comment({ id: "new-a", body: "first new" }),
    comment({ id: "new-b", body: "second new" }),
  ];
  const seen = new Set(["old"]);
  const { notifications, newlySeen } = diffNewComments("run-x", "spec", comments, seen);
  assert.deepEqual(
    notifications.map((n) => n.meta.comment_id),
    ["new-a", "new-b"],
  );
  assert.deepEqual(newlySeen, ["new-a", "new-b"]);
});

test("isPushable: unseen + unresolved is pushable", () => {
  assert.equal(isPushable(comment(), new Set()), true);
});

test("isPushable: seen is not pushable", () => {
  assert.equal(isPushable(comment(), new Set(["c1"])), false);
});

test("isPushable: resolved is not pushable", () => {
  assert.equal(isPushable(comment({ resolved: true }), new Set()), false);
});

test("renderChannelContent truncates a long anchor quote", () => {
  const long = "x".repeat(500);
  const out = renderChannelContent(comment({ anchor: { originalText: long, headingAnchor: "h", startLine: 1 } }));
  assert.ok(out.length < 200, "content should be capped, not carry the full 500-char anchor");
  assert.ok(out.endsWith("tighten this"));
});

test("commentIds collects every id (the seed records history without pushing)", () => {
  const ids = commentIds([comment({ id: "a" }), comment({ id: "b" })]);
  assert.deepEqual(ids, ["a", "b"]);
});
