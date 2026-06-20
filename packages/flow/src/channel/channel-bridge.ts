// Channel bridge — the INFRA half of the comment→push path (ADR-001: file-watch signaling, no HTTP).
// chokidar-watches the review sidecars under `<cwd>/.agentry/work/*/.review/*.annotations.json`; on
// every change it re-reads the changed sidecar, diffs it against the ids already pushed (the pure
// `diffNewComments`), and emits one `notifications/claude/channel` per new, unresolved, human-origin
// comment. The diff/meta logic is pure (channel-event.ts) — this file is only the watcher + the
// seen-set + the emit wiring, so the watcher is the single piece of I/O.
//
// Seed-not-replay: at start every existing comment id is recorded as seen WITHOUT pushing, so the
// rail's history doesn't flood the session — only comments added after start fire a channel. Each id
// pushes at most once (AC3: the agent's own writes / `review_resolve` rewrites never re-fire).
//
// Emitting is decoupled behind an `EmitFn`: the bridge knows nothing about the McpServer. `index.ts`
// passes a closure over `server.server.notification({ method:'notifications/claude/channel', … })`;
// a session that didn't load flow as a channel silently drops the notification (the spike proved
// emitting unconditionally is safe), so the bridge never branches on enablement.
import { FSWatcher, watch } from "chokidar";
import { mkdirSync } from "node:fs";
import { basename, dirname, relative, sep } from "node:path";
import type { ReviewStore } from "../domain/ports.js";
import { workRoot } from "../resolution/run-pointer.js";
import { type ChannelNotification, commentIds, diffNewComments } from "./channel-event.js";

// What the bridge needs to emit — a single async fn so the SDK (and its custom-method cast) stays in
// `index.ts` and this port is unit-testable with a plain spy.
export type EmitFn = (notification: ChannelNotification) => void | Promise<void>;

const ANNOTATIONS_SUFFIX = ".annotations.json";

// Parse `<workRoot>/<run>/.review/<gate>.annotations.json` → { run, gate }. Returns undefined for any
// path that isn't a review sidecar at that exact depth (chokidar can surface unrelated paths). The
// layout is fixed by run-pointer's `runDir(...)/.review/<gate>.annotations.json`.
export function parseSidecarPath(cwd: string, filePath: string): { run: string; gate: string } | undefined {
  const file = basename(filePath);
  if (!file.endsWith(ANNOTATIONS_SUFFIX)) return undefined;
  const reviewDir = dirname(filePath);
  if (basename(reviewDir) !== ".review") return undefined;
  const runDirPath = dirname(reviewDir);
  // `run` must be a single segment directly under the work root (no nesting, no escape).
  const rel = relative(workRoot(cwd), runDirPath);
  if (rel.length === 0 || rel.startsWith("..") || rel.includes(sep)) return undefined;
  const gate = file.slice(0, -ANNOTATIONS_SUFFIX.length);
  if (gate.length === 0) return undefined;
  return { run: rel, gate };
}

export class ChannelBridge {
  // Ids already pushed (or seeded as history). Keyed globally by comment id; ids are unique per
  // comment (minted by the review service), so a single set across runs/gates is sufficient and keeps
  // the at-most-once guarantee simple.
  private readonly seen = new Set<string>();
  private watcher: FSWatcher | undefined;

  constructor(
    private readonly cwd: string,
    private readonly reviews: ReviewStore,
    private readonly emit: EmitFn,
  ) {}

  // Start watching. Seeds existing sidecars (history → seen, no push) on the watcher's `ready` event,
  // then pushes only for comments added afterward. Idempotent-ish: a second `start` is a no-op.
  start(): void {
    if (this.watcher !== undefined) return;
    const root = workRoot(this.cwd);
    // The work root MUST exist before chokidar watches it: pointed at a missing dir, chokidar reports
    // `ready` but never establishes the recursive watch, so later-created `<run>/.review/*` sidecars
    // never fire (verified on macOS — the cause of an early "0 emits" bug). Creating it up front is
    // safe (run writes create it anyway) and makes the descendant watch reliable.
    mkdirSync(root, { recursive: true });
    // Watch the work root and filter to sidecars ourselves (chokidar v4 dropped glob patterns).
    this.watcher = watch(root, {
      ignoreInitial: false, // we WANT the initial scan — it drives the seed via `add` before `ready`
      persistent: true,
      depth: 2, // <run>/.review/<gate>.annotations.json — exactly two levels under the root
    });

    let ready = false;
    const onPath = (filePath: string): void => {
      const parsed = parseSidecarPath(this.cwd, filePath);
      if (parsed === undefined) return;
      if (!ready) {
        this.seedSidecar(parsed.run, parsed.gate); // pre-existing comment → history, no push
        return;
      }
      void this.handleChange(parsed.run, parsed.gate);
    };

    this.watcher.on("add", onPath);
    this.watcher.on("change", onPath);
    this.watcher.on("ready", () => {
      ready = true;
    });
  }

  // Tear down the watcher (shutdown path). Safe to call when never started.
  async stop(): Promise<void> {
    if (this.watcher === undefined) return;
    await this.watcher.close();
    this.watcher = undefined;
  }

  // Record every comment id on a sidecar as seen WITHOUT emitting — the startup seed.
  private seedSidecar(run: string, gate: string): void {
    for (const id of commentIds(this.readComments(run, gate))) this.seen.add(id);
  }

  // Re-read a changed sidecar and emit one channel per new, unresolved comment. The seen-set is
  // updated only for the comments actually pushed, so a future change re-evaluates the rest.
  private async handleChange(run: string, gate: string): Promise<void> {
    const { notifications, newlySeen } = diffNewComments(run, gate, this.readComments(run, gate), this.seen);
    for (const id of newlySeen) this.seen.add(id);
    for (const notification of notifications) await this.emit(notification);
  }

  // Reuse the review store's validating parser (don't fork the shape). A missing/corrupt sidecar
  // reads as empty there, so no read here throws.
  private readComments(run: string, gate: string): ReturnType<ReviewStore["read"]> {
    return this.reviews.read(run, gate);
  }
}
