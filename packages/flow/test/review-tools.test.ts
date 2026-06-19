// Review family (AC10) — drives the real review-tools adapters through a fake McpServer that captures
// each registered handler, over the REAL JsonReviewStore on a tmpdir. So the assertions run the
// genuine wire shape AND prove the comments (with the 3-way anchor) round-trip through the on-disk
// `.review/<gate>.annotations.json`. Mirrors @agentry/memory's tool-errors.test.ts harness.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { JsonReviewStore } from "../src/persistence/review-store.js";
import { registerReviewTools } from "../src/tools/review-tools.js";

// ── harness ──────────────────────────────────────────────────────────────────
type Handler = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

/** Minimal fake McpServer capturing the third positional arg (the handler) of registerTool by name. */
class CapturingServer {
  readonly handlers = new Map<string, Handler>();
  registerTool(name: string, _config: unknown, handler: Handler): void {
    this.handlers.set(name, handler);
  }
}

let cwd: string;
let call: (tool: string, args?: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "flow-review-"));
  const server = new CapturingServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerReviewTools(server as any, { reviews: new JsonReviewStore(cwd) });
  call = (tool, args = {}) => {
    const h = server.handlers.get(tool);
    if (!h) throw new Error(`tool ${tool} not registered`);
    return h(args);
  };
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function payloadOf(res: { content: { text: string }[]; isError?: boolean }) {
  assert.notEqual(res.isError, true, "expected a success response (isError falsy)");
  return JSON.parse(res.content[0]!.text);
}

const RUN = "review-run-001";
const GATE = "spec";
const ANCHOR_A = { originalText: "the quoted snippet", headingAnchor: "## Section A", startLine: 12 };
const ANCHOR_B = { originalText: "another snippet", headingAnchor: "## Section B", startLine: 40 };

// ── AC10 — the family proof: write two, resolve one, list → one resolved + one open ────────────────
test("AC10: write two comments, resolve one, list → one resolved + one open (resolved distinguishable)", async () => {
  const { id: idA } = payloadOf(await call("review_comment", { run: RUN, gate: GATE, anchor: ANCHOR_A, decision: "changes", body: "fix this" }));
  const { id: idB } = payloadOf(await call("review_comment", { run: RUN, gate: GATE, anchor: ANCHOR_B, decision: "question", body: "why this?" }));
  assert.ok(idA && idB && idA !== idB, "each comment gets a distinct id");

  const resolveRes = payloadOf(await call("review_resolve", { run: RUN, gate: GATE, id: idA }));
  assert.deepEqual(resolveRes, { id: idA, resolved: true });

  const { comments } = payloadOf(await call("review_list", { run: RUN, gate: GATE }));
  assert.equal(comments.length, 2);
  const resolved = comments.filter((c: { resolved: boolean }) => c.resolved);
  const open = comments.filter((c: { resolved: boolean }) => !c.resolved);
  assert.equal(resolved.length, 1, "exactly one resolved");
  assert.equal(open.length, 1, "exactly one open");
  assert.equal(resolved[0].id, idA, "the resolved one is the one we resolved");
  assert.equal(open[0].id, idB, "the other stays open");
});

// ── AC10 — the resolved flag round-trips through the on-disk JSON sidecar (not just in-memory) ──────
test("AC10: the resolved flag round-trips through .review/<gate>.annotations.json on disk", async () => {
  const { id } = payloadOf(await call("review_comment", { run: RUN, gate: GATE, anchor: ANCHOR_A, decision: "changes", body: "fix this" }));
  await call("review_resolve", { run: RUN, gate: GATE, id });

  const file = join(cwd, ".agentry", "work", RUN, ".review", `${GATE}.annotations.json`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(Array.isArray(raw), true);
  assert.equal(raw.length, 1);
  assert.equal(raw[0].resolved, true, "resolved persisted to the JSON file");
  assert.equal(raw[0].id, id);
});

// ── AC10 — the 3-way anchor (originalText/headingAnchor/startLine) survives write → read ───────────
test("AC10: the 3-way anchor round-trips through write → list (all three fields preserved)", async () => {
  await call("review_comment", { run: RUN, gate: GATE, anchor: ANCHOR_A, decision: "approve", body: "looks good here" });

  const { comments } = payloadOf(await call("review_list", { run: RUN, gate: GATE }));
  assert.equal(comments.length, 1);
  assert.deepEqual(comments[0].anchor, ANCHOR_A, "originalText + headingAnchor + startLine preserved");
  assert.equal(comments[0].decision, "approve");
  assert.equal(comments[0].body, "looks good here");
});

// ── per-gate isolation: a comment on one gate never bleeds into another gate's sidecar ─────────────
test("comments are scoped per gate — review_list(other gate) does not see them", async () => {
  await call("review_comment", { run: RUN, gate: "spec", anchor: ANCHOR_A, decision: "changes", body: "spec note" });
  const { comments } = payloadOf(await call("review_list", { run: RUN, gate: "plan" }));
  assert.equal(comments.length, 0, "a different gate's sidecar is empty");
});

// ── empty case: listing a gate with no comments yet returns [] (the conductor's cold read) ─────────
test("review_list on a gate with no comments returns an empty array", async () => {
  const { comments } = payloadOf(await call("review_list", { run: RUN, gate: "never-touched" }));
  assert.deepEqual(comments, []);
});

// ── resolve on an unknown id → not-found error (the comment was never written) ─────────────────────
test("review_resolve on an unknown id → isError, code:not-found naming the id", async () => {
  const res = await call("review_resolve", { run: RUN, gate: GATE, id: "c-NONEXISTENT" });
  assert.equal(res.isError, true);
  const env = JSON.parse(res.content[0]!.text).error;
  assert.equal(env.code, "not-found");
  assert.ok(env.why.includes("c-NONEXISTENT"), "why surfaces the offending id");
});

// ── resolve is idempotent: resolving an already-resolved comment succeeds, stays resolved ──────────
test("review_resolve is idempotent — resolving twice keeps it resolved", async () => {
  const { id } = payloadOf(await call("review_comment", { run: RUN, gate: GATE, anchor: ANCHOR_A, decision: "changes", body: "x" }));
  payloadOf(await call("review_resolve", { run: RUN, gate: GATE, id }));
  const second = payloadOf(await call("review_resolve", { run: RUN, gate: GATE, id }));
  assert.deepEqual(second, { id, resolved: true });
  const { comments } = payloadOf(await call("review_list", { run: RUN, gate: GATE }));
  assert.equal(comments.filter((c: { resolved: boolean }) => c.resolved).length, 1);
});
