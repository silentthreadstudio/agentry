// ChokidarWatcher proof — the live-loop trigger (task 008, AC7). Built on a throwaway temp project
// (`<tmp>/.agentry/work/<run>/`) so the test never touches the real watched tree. Asserts the
// observable contract: a file change fires a DEBOUNCED, run-keyed `RunChange` carrying the changed
// run-relative path, and unsubscribe detaches the handler.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { RunChange } from "../src/domain/ports.js";
import { ChokidarWatcher } from "../src/persistence/chokidar-watcher.js";

let root: string; // the temp project root (its .agentry/work is the watched tree)
let runDir: string; // <root>/.agentry/work/<run>
const RUN = "demo-run";
let watcher: ChokidarWatcher | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wb-watch-"));
  runDir = join(root, ".agentry", "work", RUN);
  mkdirSync(runDir, { recursive: true });
});

afterEach(async () => {
  if (watcher) await watcher.close();
  watcher = undefined;
  rmSync(root, { recursive: true, force: true });
});

// Wait until `predicate` holds or the timeout elapses — polls so the test is deterministic without a
// fixed sleep (chokidar's first event latency varies by platform).
async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for a watch event");
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Give chokidar's initial scan a moment to settle (ignoreInitial suppresses the add-storm, but the
// watcher must be ready before the change is written, or it can be missed).
async function settle(w: ChokidarWatcher): Promise<void> {
  await new Promise((r) => setTimeout(r, 300));
  void w;
}

test("fires a run-keyed debounced event carrying the changed run-relative path", async () => {
  watcher = new ChokidarWatcher(root, { debounceMs: 50 });
  const changes: RunChange[] = [];
  watcher.subscribe((c) => changes.push(c));
  await settle(watcher);

  writeFileSync(join(runDir, "spec.md"), "# changed\n");
  await waitFor(() => changes.length > 0);

  assert.equal(changes[0]?.run, RUN, "the event is keyed by the run id (the leading path segment)");
  assert.ok(
    changes[0]?.paths.includes("spec.md"),
    "the changed path is run-relative (run segment stripped)",
  );
});

test("debounces a burst of writes in one run into a single coalesced event", async () => {
  watcher = new ChokidarWatcher(root, { debounceMs: 80 });
  const changes: RunChange[] = [];
  watcher.subscribe((c) => changes.push(c));
  await settle(watcher);

  // Two quick writes within the debounce window → one event carrying both paths.
  writeFileSync(join(runDir, "spec.md"), "# a\n");
  writeFileSync(join(runDir, "plan.md"), "# b\n");
  await waitFor(() => changes.length > 0);
  // Let any further (incorrectly un-coalesced) events arrive before asserting the count.
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(changes.length, 1, "the burst coalesced into a single event");
  const paths = changes[0]?.paths ?? [];
  assert.ok(paths.includes("spec.md") && paths.includes("plan.md"), "both changed paths batched");
});

test("unsubscribe detaches the handler", async () => {
  watcher = new ChokidarWatcher(root, { debounceMs: 50 });
  const changes: RunChange[] = [];
  const off = watcher.subscribe((c) => changes.push(c));
  await settle(watcher);

  off();
  writeFileSync(join(runDir, "spec.md"), "# changed\n");
  // Give a change time to (not) arrive — an unsubscribed handler must stay empty.
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(changes.length, 0, "no events after unsubscribe");
});
