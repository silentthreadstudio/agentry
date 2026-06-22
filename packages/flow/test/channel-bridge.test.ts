// Channel bridge — the watcher wiring. Two layers:
//   1. parseSidecarPath (pure): only a `<run>/.review/<gate>.annotations.json` path resolves.
//   2. ChannelBridge over a REAL JsonReviewStore + a real chokidar watcher on a tmpdir: a pre-existing
//      comment is seeded (no push); a comment added after start fires exactly one channel with the
//      right content+meta; a resolve-rewrite re-fires nothing (AC3). The emit is a spy.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ChannelBridge, parseSidecarPath } from "../src/channel/channel-bridge.js";
import type { ChannelNotification } from "../src/channel/channel-event.js";
import { JsonReviewStore } from "../src/persistence/review-store.js";
import type { ReviewComment } from "../src/domain/review.js";

// ── parseSidecarPath (pure) ───────────────────────────────────────────────────
test("parseSidecarPath resolves a real sidecar path to {run, gate}", () => {
  const cwd = "/tmp/proj";
  const p = join(cwd, ".agentry", "work", "run-abc", ".review", "spec.annotations.json");
  assert.deepEqual(parseSidecarPath(cwd, p), { run: "run-abc", gate: "spec" });
});

test("parseSidecarPath rejects a non-annotations file", () => {
  const cwd = "/tmp/proj";
  const p = join(cwd, ".agentry", "work", "run-abc", ".review", "notes.txt");
  assert.equal(parseSidecarPath(cwd, p), undefined);
});

test("parseSidecarPath rejects a file outside .review/", () => {
  const cwd = "/tmp/proj";
  const p = join(cwd, ".agentry", "work", "run-abc", "spec.annotations.json");
  assert.equal(parseSidecarPath(cwd, p), undefined);
});

test("parseSidecarPath rejects a nested run (must be a single segment under work/)", () => {
  const cwd = "/tmp/proj";
  const p = join(cwd, ".agentry", "work", "nested", "run", ".review", "spec.annotations.json");
  assert.equal(parseSidecarPath(cwd, p), undefined);
});

// ── ChannelBridge over a real watcher ─────────────────────────────────────────
function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: "c1",
    anchor: { originalText: "the span", headingAnchor: "## H", startLine: 1 },
    decision: "changes",
    body: "do this",
    resolved: false,
    ...over,
  };
}

// Wait until `predicate` holds or the deadline passes — chokidar's fs events are async, so we poll
// rather than assert on a fixed sleep (avoids both flakiness and a hard timing dependency).
async function waitFor(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Give the bridge time to settle its initial scan (`ready`) before we mutate — a small fixed delay is
// acceptable here because we only need ready BEFORE the change, then poll for the emit.
async function settle(ms = 400): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

let cwd: string;
let store: JsonReviewStore;
let bridge: ChannelBridge;
let emitted: ChannelNotification[];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "flow-channel-"));
  store = new JsonReviewStore(cwd);
  emitted = [];
});

afterEach(async () => {
  await bridge?.stop();
  rmSync(cwd, { recursive: true, force: true });
});

test("a comment present before start is seeded, not pushed", async () => {
  store.write("run-1", "spec", [comment({ id: "pre" })]); // history
  bridge = new ChannelBridge(cwd, store, (n) => void emitted.push(n));
  bridge.start();
  await settle();
  // give any erroneous seed-push a chance to surface, then assert silence
  await waitFor(() => emitted.length > 0, 500);
  assert.equal(emitted.length, 0, "pre-existing comments are history and must not push");
});

test("a new unresolved comment added after start pushes exactly one channel", async () => {
  bridge = new ChannelBridge(cwd, store, (n) => void emitted.push(n));
  bridge.start();
  await settle();

  store.write("run-1", "spec", [comment({ id: "new", body: "please fix", decision: "question" })]);
  await waitFor(() => emitted.length >= 1);

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].content, 'Review on "the span": please fix');
  assert.deepEqual(emitted[0].meta, {
    run_id: "run-1",
    doc: "spec",
    comment_id: "new",
    decision: "question",
  });
});

// ── session-targeting gate (shouldEmit) ───────────────────────────────────────
test("a comment on a NON-owned run is not emitted (shouldEmit=false)", async () => {
  bridge = new ChannelBridge(cwd, store, (n) => void emitted.push(n), (run) => run === "mine");
  bridge.start();
  await settle();

  store.write("not-mine", "spec", [comment({ id: "drop-me" })]);
  // give an erroneous emit a chance to surface, then assert silence
  await waitFor(() => emitted.length > 0, 500);
  assert.equal(emitted.length, 0, "another session's run must not push into this session");
});

test("a comment on an OWNED run IS emitted (shouldEmit=true)", async () => {
  bridge = new ChannelBridge(cwd, store, (n) => void emitted.push(n), (run) => run === "mine");
  bridge.start();
  await settle();

  store.write("mine", "spec", [comment({ id: "keep" })]);
  await waitFor(() => emitted.length >= 1);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].meta.run_id, "mine");
});

test("a dropped (non-owned) comment is marked seen — it never re-emits even if later owned", async () => {
  // First pass: the run is not ours, so the comment is dropped but recorded as seen. Then flip the
  // gate to claim the run and rewrite the sidecar: the already-seen comment must NOT fire late.
  let owned = false;
  bridge = new ChannelBridge(cwd, store, (n) => void emitted.push(n), () => owned);
  bridge.start();
  await settle();

  store.write("run-1", "spec", [comment({ id: "once" })]);
  await waitFor(() => emitted.length > 0, 500);
  assert.equal(emitted.length, 0, "not-ours comment is dropped");

  owned = true; // now claim the run, then touch the sidecar again
  store.write("run-1", "spec", [comment({ id: "once" }), comment({ id: "fresh" })]);
  await waitFor(() => emitted.some((n) => n.meta.comment_id === "fresh"));

  // only the genuinely-new "fresh" comment fires; "once" stays suppressed (seen on the dropped pass).
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].meta.comment_id, "fresh");
});

test("resolving a pushed comment (a sidecar rewrite) does not re-fire (AC3)", async () => {
  bridge = new ChannelBridge(cwd, store, (n) => void emitted.push(n));
  bridge.start();
  await settle();

  store.write("run-1", "spec", [comment({ id: "x" })]);
  await waitFor(() => emitted.length >= 1);
  assert.equal(emitted.length, 1);

  // resolve it — same id, rewritten sidecar; the seen-set must suppress a second push
  store.write("run-1", "spec", [comment({ id: "x", resolved: true })]);
  await settle(600);
  assert.equal(emitted.length, 1, "a resolve-rewrite of an already-pushed comment must not re-fire");
});
