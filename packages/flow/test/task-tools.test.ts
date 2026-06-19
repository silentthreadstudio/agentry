// Task tools wiring tests (T02 / AC1–AC5). Drives the real adapters through a fake McpServer that
// captures each tool's (config, handler) by name — then, like the SDK, validates args against the
// tool's zod `inputSchema` BEFORE dispatching to the handler. That ordering is what proves AC2: an
// out-of-enum status is rejected at the schema boundary, so the handler never runs and no file is
// written. The store underneath is the real TaskFileStore over a tmp cwd (files = truth, ADR-001).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { z } from "zod";
import { createServices, type FlowServices } from "../src/index.js";
import { registerTaskTools } from "../src/tools/task-tools.js";

const RUN = "demo-run-001";
let cwd: string;
let services: FlowServices;

// ── harness ──────────────────────────────────────────────────────────────────
type Res = { content: { text: string }[]; isError?: boolean };
type Handler = (args: unknown) => Promise<Res>;
interface Captured {
  schema: z.ZodTypeAny;
  handler: Handler;
}

/** Fake McpServer capturing each tool's zod inputSchema + handler — mirrors the SDK's registerTool. */
class CapturingServer {
  readonly tools = new Map<string, Captured>();
  registerTool(name: string, config: { inputSchema: z.ZodRawShape }, handler: Handler): void {
    this.tools.set(name, { schema: z.object(config.inputSchema), handler });
  }
}

function wired(): {
  call: (tool: string, args?: unknown) => Promise<Res>;
  validate: (tool: string, args: unknown) => z.SafeParseReturnType<unknown, unknown>;
} {
  const server = new CapturingServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerTaskTools(server as any, services);
  // Like the SDK: validate against the tool's inputSchema, and ONLY dispatch the handler when it passes.
  const call = async (tool: string, args: unknown = {}): Promise<Res> => {
    const t = server.tools.get(tool);
    if (!t) throw new Error(`tool ${tool} not registered`);
    const parsed = t.schema.parse(args); // throws on invalid input — the SDK rejects before dispatch
    return t.handler(parsed);
  };
  const validate = (tool: string, args: unknown) => {
    const t = server.tools.get(tool);
    if (!t) throw new Error(`tool ${tool} not registered`);
    return t.schema.safeParse(args);
  };
  return { call, validate };
}

function payloadOf(res: Res): any {
  assert.notEqual(res.isError, true, "expected a success response (isError falsy)");
  return JSON.parse(res.content[0]!.text);
}
function envelopeOf(res: Res): any {
  assert.equal(res.isError, true, "expected isError:true");
  return JSON.parse(res.content[0]!.text).error;
}
const taskFile = (taskNo: string): string | undefined => {
  const dir = join(cwd, ".agentry", "work", RUN, "tasks");
  if (!existsSync(dir)) return undefined;
  const f = readdirSync(dir).find((n) => n.startsWith(`${taskNo}-`) && n.endsWith(".md"));
  return f ? readFileSync(join(dir, f), "utf8") : undefined;
};

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "flow-task-tools-"));
  services = createServices(cwd);
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

// ── AC1 / AC3 / AC5 — create + assign leaves a file with an in-enum status AND a populated lockedBy ──
test("AC1/AC3/AC5: create then assign → file exists with enum status, populated lockedBy, stamped version", async () => {
  const { call } = wired();
  const created = payloadOf(await call("task_create", { run: RUN, title: "Foundation", body: "the brief" }));
  assert.equal(created.taskNo, "001");
  assert.ok(typeof created.version === "string" && created.version.length > 0, "create stamps a version (AC5)");

  const assigned = payloadOf(await call("task_assign", { run: RUN, taskNo: "001", agent: "agentry:implementer" }));
  assert.equal(assigned.lockedBy, "agentry:implementer", "assign sets lockedBy (AC3)");
  assert.ok(typeof assigned.version === "string" && assigned.version.length > 0, "assign re-stamps a version (AC5)");

  const got = payloadOf(await call("task_get", { run: RUN, taskNo: "001" }));
  assert.equal(got.task.frontmatter.status, "todo"); // a live status in the enum (AC1)
  assert.equal(got.task.frontmatter.lockedBy, "agentry:implementer"); // never empty for an assigned task (AC1/AC3)
  assert.ok(typeof got.task.frontmatter.version === "string" && got.task.frontmatter.version.length > 0);
});

// ── AC2 — an out-of-enum status is rejected at the zod boundary; NO file is written with it ──────────
test("AC2: task_status with an out-of-enum value is rejected at the schema; the file is unchanged", async () => {
  const { call, validate } = wired();
  await call("task_create", { run: RUN, title: "T", body: "x" });
  const before = taskFile("001");
  assert.ok(before, "the created file exists");

  // the schema rejects the bad status (the SDK would refuse to dispatch)
  const result = validate("task_status", { run: RUN, taskNo: "001", status: "blocked" });
  assert.equal(result.success, false, "out-of-enum status fails schema validation (AC2)");

  // and going through the dispatch path, the handler never runs → the file is byte-identical
  await assert.rejects(call("task_status", { run: RUN, taskNo: "001", status: "blocked" }));
  assert.equal(taskFile("001"), before, "no file written with the invalid status (AC2)");
});

// ── AC2 — every enum value IS accepted (the closed set is forward-only, ADR-004) ────────────────────
test("AC2: each valid lifecycle status is accepted and lands on the file", async () => {
  const { call } = wired();
  await call("task_create", { run: RUN, title: "T", body: "x" });
  for (const status of ["todo", "in-progress", "in-review", "done"]) {
    const res = payloadOf(await call("task_status", { run: RUN, taskNo: "001", status }));
    assert.equal(res.status, status);
  }
  const got = payloadOf(await call("task_get", { run: RUN, taskNo: "001" }));
  assert.equal(got.task.frontmatter.status, "done");
});

// ── AC4 — artifact_write stamps a tool-computed version; a body edit yields a DIFFERENT version ──────
test("AC4: artifact_write stamps a version the tool computed; editing the body changes it", async () => {
  const { call } = wired();
  const first = payloadOf(await call("artifact_write", { run: RUN, kind: "spec", body: "first body" }));
  assert.equal(first.path, "spec.md");
  assert.ok(typeof first.version === "string" && first.version.length > 0);

  const edited = payloadOf(await call("artifact_write", { run: RUN, kind: "spec", body: "second — edited body" }));
  assert.notEqual(first.version, edited.version, "a body edit yields a different version (AC4)");

  // idempotent: rewriting the SAME body keeps the version (derived, deterministic)
  const same = payloadOf(await call("artifact_write", { run: RUN, kind: "spec", body: "second — edited body" }));
  assert.equal(edited.version, same.version);
});

// ── AC4 — the caller can never set the version: a caller-supplied field would be ignored (not in schema)
test("AC4: artifact_write has no caller `version` input — the tool is the only source", () => {
  const { validate } = wired();
  // a `version` key is not part of the schema; the tool computes it. Extra keys are stripped by zod's
  // object parse, so the caller's value never reaches the write path.
  const parsed = validate("artifact_write", { run: RUN, kind: "spec", body: "b", version: "CALLER-FAKE" });
  assert.equal(parsed.success, true);
  assert.equal((parsed as any).data.version, undefined, "caller-supplied version is stripped at the boundary");
});

// ── AC5 — task_status re-stamps; task_list reads created tasks from a fresh directory scan ───────────
test("AC5: task_status re-stamps the version; task_list returns created tasks (fresh scan)", async () => {
  const { call } = wired();
  const created = payloadOf(await call("task_create", { run: RUN, title: "One", body: "a" }));
  const moved = payloadOf(await call("task_status", { run: RUN, taskNo: "001", status: "in-progress" }));
  assert.ok(typeof moved.version === "string" && moved.version.length > 0);
  assert.notEqual(created.version, moved.version, "moving status re-stamps a new version (AC5)");

  await call("task_create", { run: RUN, title: "Two", body: "b" });
  const list = payloadOf(await call("task_list", { run: RUN }));
  assert.equal(list.tasks.length, 2, "task_list returns both created tasks from a fresh read");
  assert.deepEqual(
    list.tasks.map((t: any) => t.taskNo),
    ["001", "002"],
  );
});

// ── create numbers sequentially from a pure-file scan (ADR-001) ─────────────────────────────────────
test("task_create numbers the next task from the existing files (001, 002, 003)", async () => {
  const { call } = wired();
  assert.equal(payloadOf(await call("task_create", { run: RUN, title: "a" })).taskNo, "001");
  assert.equal(payloadOf(await call("task_create", { run: RUN, title: "b" })).taskNo, "002");
  assert.equal(payloadOf(await call("task_create", { run: RUN, title: "c" })).taskNo, "003");
});

// ── not-found — assign/status/get on a missing task → a not-found envelope, not a throw ──────────────
test("assign/status/get on a non-existent task → not-found envelope (no file)", async () => {
  const { call } = wired();
  for (const [tool, args] of [
    ["task_assign", { run: RUN, taskNo: "099", agent: "x" }],
    ["task_status", { run: RUN, taskNo: "099", status: "done" }],
    ["task_get", { run: RUN, taskNo: "099" }],
  ] as const) {
    const env = envelopeOf(await call(tool, args));
    assert.equal(env.code, "not-found");
  }
  assert.equal(taskFile("099"), undefined, "no file conjured for a missing task");
});
