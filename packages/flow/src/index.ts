// @agentry/flow — stdio MCP server entry. Wires the layers: resolve the run context (explicit run,
// ADR-005 NO branch) → build the file-store services → register the four tool families → connect the
// transport. Mirrors @agentry/memory's index.ts. Server name: "agentry-flow".
//
// This file owns the REGISTRATION CONTRACT the four sibling tasks (T02–T05) fill: each tool family
// exports a `register<Family>Tools(server, ctx)` taking the McpServer and the shared `FlowServices`
// context. Until those files land, the four registrations are stubbed below behind the agreed
// signature with a `// T0x fills this` marker — the siblings replace the BODY (moving each stub into
// its own `tools/<family>-tools.ts` and switching the import here), never the signature.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JsonlEventLog } from "./persistence/event-log.js";
import { JsonReviewStore } from "./persistence/review-store.js";
import { JsonRunStateStore } from "./persistence/run-state-store.js";
import { TaskFileStore } from "./persistence/task-file-store.js";
import type { EventLog, ReviewStore, RunStore, TaskStore } from "./domain/ports.js";
import { resolveRunFromSession, workRoot } from "./resolution/run-pointer.js";
import { registerTaskTools } from "./tools/task-tools.js";
import { registerMonitorTools } from "./tools/monitor-tools.js";
import { registerAgentTools } from "./tools/agent-tools.js";
import { registerReviewTools } from "./tools/review-tools.js";

// The shared service context every tool family receives — the file-store adapters (the only state
// holders, AC6) plus the resolved cwd. T02–T05's `register*Tools` close over this; the run is NOT
// here (there is no ambient run — every tool takes `run` as an explicit arg, ADR-005 NO branch).
export interface FlowServices {
  cwd: string;
  tasks: TaskStore;
  events: EventLog;
  reviews: ReviewStore;
  runs: RunStore;
}

// Build the file-store services over a cwd. Centralized so `main` and tests construct them identically.
export function createServices(cwd: string): FlowServices {
  return {
    cwd,
    tasks: new TaskFileStore(cwd),
    events: new JsonlEventLog(cwd),
    reviews: new JsonReviewStore(cwd),
    runs: new JsonRunStateStore(cwd),
  };
}

/**
 * Resolve the run a call operates on (ADR-005 NO branch). Precedence: an explicit `run` arg > the
 * session pointer (only when the caller passes `session_id`) > a HARD ERROR. It NEVER scans
 * `.agentry/work/` for a newest-mtime folder and holds NO ambient "current run" — the server is
 * stateless w.r.t. the session and may serve concurrent callers. An unresolved run is a real misuse
 * (the skill mandates run_start first), surfaced as an error, not a silent best-effort guess.
 */
export function resolveRunContext(
  args: { run?: string; session_id?: string },
  env: NodeJS.ProcessEnv = process.env,
): { cwd: string; run: string } {
  const cwd = env.CLAUDE_PROJECT_DIR ?? env.AGENTRY_PROJECT_DIR ?? process.cwd();

  // 1) Explicit run arg wins — the caller-threaded handle (the normal path).
  if (args.run !== undefined && args.run.length > 0) {
    return { cwd, run: args.run };
  }

  // 2) Session pointer — ONLY when the caller explicitly passes session_id (FLOW never reads it from
  //    its own absent context). Resolves via the binder's pointer; undefined when unbound.
  if (args.session_id !== undefined && args.session_id.length > 0) {
    const resolved = resolveRunFromSession(cwd, args.session_id);
    if (resolved !== undefined) return { cwd, run: resolved };
  }

  // 3) Unresolved → hard error. NEVER a folder scan (the named anti-pattern). `workRoot` is named in
  //    the message only to point the caller at where runs live, not to scan it.
  throw new Error(
    `FLOW: no run resolved — pass an explicit "run" (call run_start first to mint one). FLOW does not ` +
      `scan ${workRoot(cwd)} for a current run and holds no ambient run (ADR-005).`,
  );
}

// ---- Registration contract (T02–T05 fill these) ----
// Each tool family lives in its own `tools/<family>-tools.ts` and exports the agreed signature
// `register<Family>Tools(server, ctx)` — imported above and wired into `main` below. The shared
// `FlowServices` context (the file-store adapters + cwd) is threaded into all four; none holds an
// ambient run (ADR-005 NO branch — `run` is an explicit per-call arg).

export async function main(): Promise<void> {
  const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.env.AGENTRY_PROJECT_DIR ?? process.cwd();
  const services = createServices(cwd);

  const server = new McpServer({ name: "agentry-flow", version: "0.1.0" });
  registerTaskTools(server, services);
  registerMonitorTools(server, services);
  registerAgentTools(server, services);
  registerReviewTools(server, services);

  await server.connect(new StdioServerTransport());
}

// Entry point: connect the stdio transport ONLY when invoked directly (`node dist/index.js`), never
// on import — so test/tooling that imports `resolveRunContext`/`createServices` doesn't block on the
// transport (mirrors packages/eval/src/cli.ts's `invokedDirectly` guard).
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`[flow] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
