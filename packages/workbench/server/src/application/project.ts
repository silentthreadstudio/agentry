// project — one served project: its root, its stable slug, and the whole read/write tree rooted at it.
//
// This is the unit the Workbench multiplexes. Everything below used to be built once, inline in the
// composition root, against a single spawn-time root; it is a factory now so the server can hold several
// projects at once and a request can name which one it means (`?project=<slug>`).
//
// The tree itself is unchanged (ADR-001's ports-and-adapters): fs repository + watcher → WorkReader,
// FlowWriter → WriteService, and the Phase-4 aggregation readers. Only its lifetime changed — one per
// project instead of one per process.
import { basename } from "node:path";
import { FsWorkRepository } from "../persistence/fs-work-repository.js";
import { ChokidarWatcher } from "../persistence/chokidar-watcher.js";
import { PermissionWatcher } from "../persistence/permission-watcher.js";
import { FlowWriter } from "../persistence/flow-writer.js";
import { FsEventSource } from "../persistence/event-source.js";
import { FsReviewSidecarSource } from "../persistence/review-sidecar-source.js";
import { TranscriptReader } from "../persistence/transcript-reader.js";
import { MemReader } from "../persistence/mem-reader.js";
import { RunStarter } from "../persistence/run-starter.js";
import { WorkReader } from "./work-reader.js";
import { WriteService } from "./write-service.js";
import { EventStore } from "./event-store.js";
import { GateInbox } from "./gate-inbox.js";
import { TokenReader } from "./token-reader.js";
import type { Clock } from "../domain/ports.js";

export interface Project {
  /** The URL-facing name (`?project=<slug>`): the root's basename, suffixed on collision. */
  slug: string;
  root: string;
  reader: WorkReader;
  writeService: WriteService;
  events: EventStore;
  gates: GateInbox;
  tokens: TokenReader;
  memory: MemReader;
  /** Starts NEW work in this project (FLOW's `run_start`, reused). */
  starter: RunStarter;
  watcher: ChokidarWatcher;
  permissionWatcher: PermissionWatcher;
}

/** Build the full tree for one project root. `slug` is supplied by the caller because uniqueness is a
 *  property of the SET of projects, not of one root. */
export function createProject(root: string, slug: string, clock: Clock): Project {
  const repository = new FsWorkRepository(root);
  const events = new EventStore(repository, new FsEventSource(root));
  return {
    slug,
    root,
    reader: new WorkReader(repository, clock, (run) => events.roster(run).length),
    writeService: new WriteService(new FlowWriter(root)),
    events,
    gates: new GateInbox(repository, new FsReviewSidecarSource(root)),
    tokens: new TokenReader(new TranscriptReader(root)),
    memory: new MemReader(root),
    starter: new RunStarter(root),
    watcher: new ChokidarWatcher(root),
    permissionWatcher: new PermissionWatcher(root),
  };
}

/** Stable, collision-free slugs for a set of roots. The basename is the readable default; a second root
 *  with the same basename (two checkouts of the same repo, a `web` inside two monorepos) is disambiguated
 *  by appending a short hash of its full path rather than a positional index — so a slug stays the same
 *  regardless of registration order or which projects are open. */
export function slugsFor(roots: readonly string[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const root of roots) {
    const name = basename(root);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const slugs = new Map<string, string>();
  for (const root of roots) {
    const name = basename(root);
    slugs.set(root, (counts.get(name) ?? 0) > 1 ? `${name}-${shortHash(root)}` : name);
  }
  return slugs;
}

// FNV-1a → 6 base36 chars. Same tool (and same reasoning) as workSlug's: a readable disambiguator, not a
// security token.
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(6, "0").slice(-6);
}
