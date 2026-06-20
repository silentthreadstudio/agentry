// Ports — the seams the server's application layer depends on (ADR-001). PURE: interfaces only, no
// I/O. Concrete adapters live in `persistence/` and `transport/`; the application is unit-testable
// against fakes of these ports without a real fs or websocket. The dependency arrow points inward —
// this file imports only the read-model contract (`@agentry/workbench-shared`) and FLOW's on-disk
// shapes (`@agentry/flow/domain`, ADR-005/007); it imports NOTHING from application/persistence/
// transport/instance.
//
// Every port is keyed by an explicit `run` (the run id — a single traversal-safe path segment, the
// `.agentry/work/<run>/` folder name). There is NO ambient "current run": the server is stateless
// w.r.t. the session (ADR-001), so the caller threads `run` on every call. Plain values cross every
// port — no `node:fs`/`ws` types leak through, keeping the domain pure.
import type { WsMessage } from "@agentry/workbench-shared";
import type { FlowTask } from "@agentry/flow/domain/ports";

// The parsed contents of one `.agentry/work/<run>/` directory — the read side of `WorkRepository`,
// and the sole input to `buildGraph` (see graph.ts). Already-parsed plain data (frontmatter +
// body), never raw file handles, so the domain stays pure: the fs adapter does the reading, the
// domain does the shaping. `routing` is the run's routing-decision event (the graph root, VISION §4)
// when one has been emitted; `spec`/`plan` are the run-root artifacts when present; `adrs`/`tasks`
// are the per-file records. Frontmatter is loose (`Record<string, unknown>`) — the application owns
// each file's field semantics; the domain reads only the fields it derives the graph from.
export interface RunFiles {
  run: string; // the run id (the folder name)
  routing: RoutingInfo | null; // the routing-decision event, or null before one is emitted
  spec: ArtifactFile | null; // run-root spec.md, or null when absent
  plan: ArtifactFile | null; // run-root plan.md, or null when absent
  adrs: ArtifactFile[]; // adr/*.md records (id-keyed via frontmatter `id`)
  tasks: FlowTask[]; // tasks/NNN-*.md records (FLOW's parsed shape, reused not redefined)
}

// The routing decision that opened the run — the shape the conductor chose and the kind of work.
// A projection of FLOW's `RoutingDecisionEvent` (kept to the two fields the graph root displays).
export interface RoutingInfo {
  shape: string; // "one-shot" | "spec-first" | "decompose+verify"
  kind: string; // "feature" | "bug" | ...
}

// A parsed run-root or adr artifact: its frontmatter (loose) and body prose. Mirrors FLOW's
// `FlowTask` minus the task number — the artifacts the graph derives spec/plan/adr nodes from.
export interface ArtifactFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

// WorkRepository — the read side over the `.agentry/work/` tree (ADR-001). Lists the runs present,
// and parses one run dir into the plain `RunFiles` the application folds into read-models. The fs
// adapter (`FsWorkRepository`) implements it; the domain never touches the disk.
export interface WorkRepository {
  listRuns(): string[]; // the run ids present under .agentry/work/
  readRun(run: string): RunFiles | undefined; // parsed run dir, or undefined when the run is absent
}

// A debounced file-change notification for a run — the parsed-agnostic signal the transport pushes
// downstream. `paths` are the changed file paths relative to the run root (the batch coalesced by the
// debounce window).
export interface RunChange {
  run: string;
  paths: string[];
}

// Watcher — subscribes to run-keyed, debounced change events over the watched `.agentry/work/` tree.
// `subscribe` returns an unsubscribe handle so a transport can detach a closed connection. The fs
// adapter (`ChokidarWatcher`) implements it; the domain depends only on the callback contract.
export interface Watcher {
  subscribe(handler: (change: RunChange) => void): () => void;
}

// Transport — pushes a read-model `WsMessage` (the shared discriminated envelope) to the clients
// subscribed to a run. The ws adapter implements it; the application calls it to fan a change out.
// `pushAll` broadcasts to EVERY connected client (the base host included), for project-global messages
// that belong to no single run — the permission relay (Phase 3b) is the one consumer: permissions are
// session/project-level, so the approvals banner must reach the bare host as well as every run host.
export interface Transport {
  push(run: string, message: WsMessage): void;
  pushAll(message: WsMessage): void;
}

// MemSource — read-only access to the project's `mem` file-store (Phase 4, the memory panel). A
// reserved seam: the domain pins the read contract now; the `persistence/` `MemReader` adapter lands
// with the consuming feature. Returns plain records — no memory-store types leak across.
export interface MemSource {
  list(): MemRecord[]; // every memory record the store holds
  read(id: string): MemRecord | undefined; // one record by id, or undefined when absent
}

// One memory record as the panel reads it — loose `fields` (the store owns the field contract; this
// port only ferries the parsed record, read-only).
export interface MemRecord {
  id: string;
  fields: Record<string, unknown>;
}

// TranscriptSource — read-only access to Claude Code session transcripts (Phase 4, the Tokens chart).
// A reserved seam, same discipline as `MemSource`: returns plain token samples, never fs handles.
export interface TranscriptSource {
  read(run: string): TokenSample[]; // the token-usage samples observed for the run, in time order
}

// One token-usage sample — a timestamp and the cumulative token count at it (the chart-friendly pair
// the read-model's `TokenSeries` is folded from).
export interface TokenSample {
  timestamp: string; // ISO sample time
  tokens: number; // cumulative token count at the sample
}

// Clock — the single source of "now", injected so time-dependent application logic (cache stamps,
// `updatedAt`) is deterministic under test. Returns an ISO-8601 string (the read-models' timestamp
// format).
export interface Clock {
  now(): string;
}
