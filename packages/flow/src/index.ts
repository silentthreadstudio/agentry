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
import { registerChannelReplyTools } from "./tools/channel-reply-tools.js";
import { ChannelBridge } from "./channel/channel-bridge.js";
import type { ChannelNotification } from "./channel/channel-event.js";
import { PermissionRelay } from "./channel/permission-relay.js";
import type { PermissionVerdictNotification } from "./channel/permission-event.js";

// The experimental capability key for the live human↔agent channel. Declaring it is load-safe and
// additive (the spike proved: ignored without the `--dangerously-load-development-channels` dev
// flag, never breaks normal tool loading — AC1). The notification METHOD has no capability gate, so
// the bridge emits without throwing even when the session didn't load flow as a channel.
const CHANNEL_CAPABILITY = "claude/channel";
const CHANNEL_METHOD = "notifications/claude/channel";

// The experimental capability key for permission relay (channels.md "Relay permission prompts",
// Phase 3a). Declaring it tells Claude Code (≥ 2.1.81) to forward tool-approval prompts to flow as
// `notifications/claude/channel/permission_request`; flow surfaces them to the Workbench and relays
// the human's verdict back as `notifications/claude/channel/permission`. Additive + load-safe (like
// `claude/channel`: ignored without the dev flag, and earlier CC versions ignore the capability).
// SECURITY (channels.md): only declare relay if the inbound sender is authenticated — our verdict
// sender is the localhost-only Workbench writing into `<cwd>/.agentry/run/permissions/` (a local-fs
// trust boundary, no network surface), so the gate is met. The verdict METHOD has no capability gate,
// so the relay emits without throwing even when the session didn't load flow as a channel.
const PERMISSION_CAPABILITY = "claude/channel/permission";
const PERMISSION_METHOD = "notifications/claude/channel/permission";

// Tells Claude how to treat the channel events the bridge pushes — what the `<channel …>` tag means
// and what to do with it. Carried on the server's `instructions` so it reaches the session on load.
const CHANNEL_INSTRUCTIONS =
  'Events tagged `<channel source="agentry-flow" run_id=… doc=… decision=…>` are live human review ' +
  "comments left in the Agentry Workbench on a run's artifact. Read them and act: address the comment " +
  "by editing the referenced doc (respecting locks/version) and/or resolving it. The run_id and doc " +
  "identify which artifact; decision is approve|changes|question.";

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

  const server = new McpServer(
    { name: "agentry-flow", version: "0.1.0" },
    {
      // Additive + load-safe (AC1): declared experimental capability is ignored without the dev flag.
      // `tools: {}` is the existing default; declaring it explicitly here keeps the four tool families
      // advertised exactly as before alongside the new channel capability.
      capabilities: {
        // `claude/channel`: the live human→agent review-comment push (Phase 1). `claude/channel/permission`:
        // tool-approval relay (Phase 3a) — both additive + load-safe (ignored without the dev flag).
        experimental: { [CHANNEL_CAPABILITY]: {}, [PERMISSION_CAPABILITY]: {} },
        tools: {},
      },
      instructions: CHANNEL_INSTRUCTIONS,
    },
  );
  registerTaskTools(server, services);
  registerMonitorTools(server, services);
  registerAgentTools(server, services);
  registerReviewTools(server, services);
  registerChannelReplyTools(server, services); // ADR-002: the agent→human reply lane

  // Permission relay (Phase 3a): register the permission_request handler on the low-level Server
  // BEFORE connect (channels.md registers it between the ctor and `connect`). The custom verdict
  // method isn't in the SDK's typed notification union, so the emit is cast at this single seam; the
  // relay stays SDK-agnostic behind `EmitVerdictFn`. Load-safe: a non-permission session never sends
  // a permission_request, so the handler never fires.
  const emitVerdict = async (n: PermissionVerdictNotification): Promise<void> => {
    await server.server.notification({
      method: PERMISSION_METHOD,
      params: n.params,
    } as Parameters<typeof server.server.notification>[0]);
  };
  const relay = new PermissionRelay(cwd, emitVerdict);
  server.server.setNotificationHandler(PermissionRelay.requestSchema, relay.onRequestNotification);

  await server.connect(new StdioServerTransport());

  // Channel bridge (Phase 1 comment→push): watch the review sidecars and push new human comments as
  // `notifications/claude/channel`. Started AFTER connect so emits land on a live transport. Emitting
  // is unconditional — silently dropped if the session didn't load flow as a channel (spike-proven),
  // so the bridge needs no enablement branch. The custom notification method isn't in the SDK's typed
  // notification union, so the emit is cast at this single seam (the low-level `Server` is at
  // `McpServer.server`); the bridge itself stays SDK-agnostic behind the `EmitFn`.
  const emit = async (n: ChannelNotification): Promise<void> => {
    await server.server.notification({
      method: CHANNEL_METHOD,
      params: { content: n.content, meta: n.meta },
    } as Parameters<typeof server.server.notification>[0]);
  };
  const bridge = new ChannelBridge(cwd, services.reviews, emit);
  bridge.start();

  // Start the verdict watcher AFTER connect so an emitted verdict lands on a live transport (mirrors
  // the bridge). Watches `<cwd>/.agentry/run/permissions/*.verdict.json`; emits the verdict back for
  // any pending request id, then deletes both files.
  relay.start();

  // Tear both watchers down on transport close so a server restart doesn't leak a dangling watcher.
  server.server.onclose = () => {
    void bridge.stop();
    void relay.stop();
  };
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
