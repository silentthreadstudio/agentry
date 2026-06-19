// Closed status vocabularies — the schema enforcement that makes drift impossible (spec §3 / AC2).
// Pure zod shapes, no I/O. A value outside a set fails to parse, so a forgotten/typo'd status can
// never reach a file (the documented v1 failure: the status vocabulary silently drifted).
import { z } from "zod";

// The task lifecycle. Closed: todo → in-progress → in-review → done. A fifth value fails to parse.
export const FlowTaskStatus = z.enum(["todo", "in-progress", "in-review", "done"]);
export type FlowTaskStatus = z.infer<typeof FlowTaskStatus>;

// A dispatched agent's live state (FLOW records it; it does not dispatch — spec §3.1 Agents).
export const AgentState = z.enum(["working", "blocked", "done"]);
export type AgentState = z.infer<typeof AgentState>;
