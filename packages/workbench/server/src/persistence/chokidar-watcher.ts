// ChokidarWatcher — the live-loop trigger (AC7, the `Watcher` port). Watches the `.agentry/work/`
// tree and emits DEBOUNCED, run-keyed `RunChange` events: a batch of file changes within one run,
// coalesced over a short window into a single notification per run. Phase 1 wires the subscription to
// the ws push in task 9; the watcher itself is transport-agnostic (plain `RunChange` out, no ws type).
//
// ── Why watch the work root, keyed by the first segment ───────────────────────────────────────────
// chokidar's `cwd` is set to `<cwd>/.agentry/work`, so every emitted path is `<run>/<rest…>` — the run
// id is the leading segment, and the per-run-relative path (the port's `RunChange.paths`) is the rest.
// `ignoreInitial` suppresses the add-storm of the initial scan, so a subscriber sees only live changes.
import { watch } from "chokidar";
import type { FSWatcher } from "chokidar";
import { sep } from "node:path";
import { workRoot } from "@agentry/flow/resolution/run-pointer";
import type { RunChange, Watcher } from "../domain/ports.js";

// The debounce window: changes within this many ms of each other coalesce into one event per run.
// Small enough to feel live, large enough to fold a multi-file write (an artifact + its version stamp)
// into a single push.
const DEFAULT_DEBOUNCE_MS = 100;

export interface ChokidarWatcherOptions {
  debounceMs?: number;
}

export class ChokidarWatcher implements Watcher {
  private readonly fsWatcher: FSWatcher;
  private readonly handlers = new Set<(change: RunChange) => void>();
  private readonly debounceMs: number;

  // Per-run pending batch: the coalesced set of changed run-relative paths and its flush timer.
  private readonly pending = new Map<string, { paths: Set<string>; timer: ReturnType<typeof setTimeout> }>();

  constructor(cwd: string, options: ChokidarWatcherOptions = {}) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    // Watch the work root; `cwd` makes every reported path relative to it (`<run>/<rest>`).
    this.fsWatcher = watch(".", {
      cwd: workRoot(cwd),
      ignoreInitial: true,
      persistent: true,
    });
    this.fsWatcher.on("all", (_event, path) => this.onChange(path));
  }

  // Register a change handler; returns an unsubscribe handle (a transport detaches a closed connection).
  subscribe(handler: (change: RunChange) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // Stop watching and clear any pending debounce timers. Async — chokidar's `close` returns a Promise.
  async close(): Promise<void> {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    await this.fsWatcher.close();
  }

  // Route one raw change into its run's pending batch, (re)arming the debounce timer. A path with no
  // run segment (a stray file directly under work/) is ignored — there is no run to key it to.
  private onChange(path: string): void {
    const segments = path.split(sep);
    const run = segments[0];
    if (run === undefined || run.length === 0) return;
    const relative = segments.slice(1).join("/");

    const existing = this.pending.get(run);
    if (existing) {
      if (relative.length > 0) existing.paths.add(relative);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.flush(run), this.debounceMs);
      return;
    }
    const paths = new Set<string>();
    if (relative.length > 0) paths.add(relative);
    this.pending.set(run, { paths, timer: setTimeout(() => this.flush(run), this.debounceMs) });
  }

  // Emit the coalesced batch for a run, then drop it. A copy of the handler set is iterated so a
  // handler that unsubscribes mid-flush does not mutate the set under iteration.
  private flush(run: string): void {
    const batch = this.pending.get(run);
    if (!batch) return;
    this.pending.delete(run);
    const change: RunChange = { run, paths: [...batch.paths] };
    for (const handler of [...this.handlers]) handler(change);
  }
}
