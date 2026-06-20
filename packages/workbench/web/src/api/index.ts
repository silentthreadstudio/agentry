// @agentry/workbench-web api barrel — the single import surface for the web's read-model client. The
// fetchers are split by resource (works/graph/context/events/gates/review/memory/permissions) over the
// shared http core; the ws push client lives in `ws.ts`. Pages import from here, not the resource files,
// so a resource can be reshaped without touching every call site.
export { ApiError } from "./http.js";
export { fetchWorks } from "./works.js";
export { fetchGraph } from "./graph.js";
export { fetchContext, type AppContext } from "./context.js";
export { fetchEvents, fetchAgents } from "./events.js";
export { fetchGates, type OpenGateItem } from "./gates.js";
export { fetchReview, type ReviewComment } from "./review.js";
export { fetchMemory, type MemReadRecord } from "./memory.js";
export { fetchPermissions, postVerdict } from "./permissions.js";
export {
  createWsClient,
  getWsClient,
  type WsClient,
  type WsListener,
  type WsStatus,
  type WsStatusListener,
} from "./ws.js";

// Re-export the shared read-model types the pages reach through the client (so a page imports its data
// type from the same place as its fetcher).
export type {
  AgentView,
  EventView,
  GateItem,
  PermissionRequest,
} from "@agentry/workbench-shared";
