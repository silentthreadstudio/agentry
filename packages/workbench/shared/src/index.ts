// @agentry/workbench-shared — the read-model contract barrel (ADR-005 tier 2). The single public
// surface both halves of the Workbench import: the server's aggregator produces these shapes, the web
// client's `api/` consumes them. Pure re-export — every type is defined in `types.ts`; this file adds
// no shapes of its own (mirrors @agentry/core's barrel).
export type {
  AgentView,
  DiffReadyMessage,
  DocLock,
  DocModel,
  DocUpdatedMessage,
  EventView,
  FileChangedMessage,
  GateItem,
  GraphEdge,
  GraphEdgeKind,
  GraphModel,
  GraphNode,
  RunSummary,
  TokenSeries,
  WsMessage,
} from "./types.js";

// The run-id → short subdomain-label helpers (a runtime util, not a type — both halves import it).
export { resolveSlug, workSlug } from "./slug.js";
