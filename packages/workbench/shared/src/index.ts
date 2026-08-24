// @agentry/workbench-shared — the read-model contract barrel (ADR-005 tier 2). The single public
// surface both halves of the Workbench import: the server's aggregator produces these shapes, the web
// client's `api/` consumes them. Pure re-export — every type is defined in `types.ts`; this file adds
// no shapes of its own (mirrors @agentry/core's barrel).
export type {
  AgentView,
  BacklogItem,
  BoardCard,
  BoardColumn,
  BoardConflict,
  BoardModel,
  DiffReadyMessage,
  DocLock,
  DocModel,
  DocUpdatedMessage,
  EventView,
  FileChangedMessage,
  GateItem,
  RunDoc,
  PermissionAddedMessage,
  PermissionRemovedMessage,
  PermissionRequest,
  RunSummary,
  TokenSeries,
  WorksChangedMessage,
  WsMessage,
} from "./types.js";

// The run-id → short label helpers (a runtime util, not a type — both halves import it).
export { resolveSlug, workSlug } from "./slug.js";

// The conductor thread — the reserved `.review/` gate a human uses to TALK to a run rather than annotate
// a document. Re-exported from FLOW (the owner of the review vocabulary) rather than restated, so the web
// client and the server cannot drift on the gate name that routes a message into the conducting session.
export { CONDUCTOR_GATE, anchorlessSpan, isConductorThread } from "@agentry/flow/domain/review";
