// channel_reply (ADR-002, Phase 2a) — drives the real channel-reply adapter through a fake McpServer
// over the REAL JsonReviewStore on a tmpdir, so the assertions prove an agent reply round-trips through
// the on-disk `.review/<doc>.annotations.json` with the agent-origin marking. Mirrors review-tools.test.ts.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { JsonReviewStore } from "../src/persistence/review-store.js";
import { registerChannelReplyTools } from "../src/tools/channel-reply-tools.js";
import { registerReviewTools } from "../src/tools/review-tools.js";

type Handler = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

class CapturingServer {
  readonly handlers = new Map<string, Handler>();
  registerTool(name: string, _config: unknown, handler: Handler): void {
    this.handlers.set(name, handler);
  }
}

let cwd: string;
let call: (tool: string, args?: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "flow-channel-reply-"));
  const server = new CapturingServer();
  const store = new JsonReviewStore(cwd);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerChannelReplyTools(server as any, { reviews: store });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerReviewTools(server as any, { reviews: store });
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

const RUN = "reply-run-001";
const DOC = "plan";

// ── the core promise: a reply appends an agent-origin entry with replyTo, on the .review/ bus ──────
test("channel_reply appends an agent-origin entry with replyTo to the .review/ sidecar", async () => {
  const { id } = payloadOf(await call("channel_reply", { run: RUN, doc: DOC, body: "on it", replyTo: "c-human-42" }));
  assert.ok(id, "the reply gets an id back");

  const file = join(cwd, ".agentry", "work", RUN, ".review", `${DOC}.annotations.json`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(raw.length, 1);
  assert.equal(raw[0].id, id);
  assert.equal(raw[0].origin, "agent", "marked agent-origin so the bridge skips it + read-models stay human-only");
  assert.equal(raw[0].replyTo, "c-human-42", "threads to the human comment it answers");
  assert.equal(raw[0].body, "on it");
  assert.equal(raw[0].resolved, true, "not an open human gate item");
});

// ── replyTo is optional: a bare status reply omits it ──────────────────────────────────────────────
test("channel_reply without replyTo omits the field (a free-standing status reply)", async () => {
  const { id } = payloadOf(await call("channel_reply", { run: RUN, doc: DOC, body: "done — take another look" }));
  const file = join(cwd, ".agentry", "work", RUN, ".review", `${DOC}.annotations.json`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(raw[0].id, id);
  assert.equal(raw[0].origin, "agent");
  assert.equal(Object.hasOwn(raw[0], "replyTo"), false, "no replyTo key when none supplied");
});

// ── the reply lands on the SAME bus as the human comments (one sidecar, two message kinds) ─────────
test("a human comment and an agent reply co-exist in one sidecar; review_list shows only the human one", async () => {
  const { id: human } = payloadOf(
    await call("review_comment", { run: RUN, gate: DOC, anchor: { originalText: "x", headingAnchor: "h", startLine: 1 }, decision: "changes", body: "fix this" }),
  );
  await call("channel_reply", { run: RUN, doc: DOC, body: "acknowledged", replyTo: human });

  // both entries are on disk…
  const file = join(cwd, ".agentry", "work", RUN, ".review", `${DOC}.annotations.json`);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).length, 2);

  // …but review_list (the conductor's at-gate read) sees only the human comment.
  const { comments } = payloadOf(await call("review_list", { run: RUN, gate: DOC }));
  assert.equal(comments.length, 1, "the agent reply is filtered out of review_list");
  assert.equal(comments[0].id, human);
});

// ── a poisoned doc (traversal) is rejected by the store's segment guard → internal envelope ────────
test("channel_reply with a traversal doc → isError (segment guard rejects it)", async () => {
  const res = await call("channel_reply", { run: RUN, doc: "../escape", body: "x" });
  assert.equal(res.isError, true);
});
