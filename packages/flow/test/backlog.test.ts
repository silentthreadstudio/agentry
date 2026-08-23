// Backlog proof (doc 18 slice 1) — the store's on-disk shape, the service's lifecycle, and the claim
// loop. Against a real temp dir, because "files are truth" is the property under test: an item must
// survive the process that wrote it (AC1).
//
// The claim tests carry the spec's honesty rule (§3.2): moving an item to `ready` starts NOTHING. Only
// an explicit claim mints a run, and only a session can claim. If that ever inverts, the UI's promise
// ("nothing starts work you didn't start") becomes a lie, so it is pinned here.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { BacklogItem, isReady, mintBacklogId } from "../src/domain/backlog.js";
import { FsBacklogStore } from "../src/persistence/backlog-store.js";
import { BacklogService } from "../src/application/backlog-service.js";
import { RunService } from "../src/application/run-service.js";
import { createServices } from "../src/index.js";

let cwd: string;
const clock = (() => {
  let n = 0;
  return () => new Date(Date.UTC(2026, 7, 22, 0, 0, n++)).toISOString();
})();

function service(): BacklogService {
  const services = createServices(cwd);
  return new BacklogService(services.backlog, new RunService(services), clock);
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "agentry-backlog-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

// ── the id ─────────────────────────────────────────────────────────────────────────────────────────
test("an item id is a b-prefixed, traversal-safe single segment", () => {
  const id = mintBacklogId("Import backlog items from GitHub issues");
  assert.match(id, /^b-import-backlog-items-[a-z0-9]+$/);
  assert.ok(!id.includes("/") && !id.includes(".."));
});

test("a title that slugs to nothing still mints a usable id", () => {
  assert.match(mintBacklogId("!!! ???"), /^b-item-[a-z0-9]+$/);
});

// ── the store (AC1) ────────────────────────────────────────────────────────────────────────────────
test("an item round-trips through the file store — it survives the process that wrote it", () => {
  const store = new FsBacklogStore(cwd);
  const item = BacklogItem.parse({
    id: "b-test-abc123",
    title: "Cap the verify retries",
    kind: "perf",
    status: "backlog",
    createdAt: clock(),
    updatedAt: clock(),
    runs: [],
    body: "Two loops, then escalate.",
  });
  store.write(item);

  // A DIFFERENT store instance reads it back — nothing is held in memory.
  const read = new FsBacklogStore(cwd).read("b-test-abc123");
  assert.deepEqual(read, item);
});

test("the file is markdown: frontmatter + the body below it, readable by hand", () => {
  const store = new FsBacklogStore(cwd);
  store.write(
    BacklogItem.parse({
      id: "b-shape-1",
      title: "Shape",
      createdAt: clock(),
      updatedAt: clock(),
      body: "# Context\n\nsome prose",
    }),
  );
  const text = readFileSync(join(cwd, ".agentry", "backlog", "b-shape-1.md"), "utf8");
  assert.ok(text.startsWith("---\n"), "frontmatter first");
  assert.match(text, /title: Shape/);
  assert.match(text, /# Context/);
  assert.ok(!/body:/.test(text.split("---")[1] ?? ""), "the body is prose below, not a yaml field");
});

test("a body carrying its own leading frontmatter cannot produce a double block", () => {
  const store = new FsBacklogStore(cwd);
  store.write(
    BacklogItem.parse({
      id: "b-double-1",
      title: "Double",
      createdAt: clock(),
      updatedAt: clock(),
      body: "---\nid: sneaky\n---\n\nreal body",
    }),
  );
  const text = readFileSync(join(cwd, ".agentry", "backlog", "b-double-1.md"), "utf8");
  assert.equal(text.match(/^---$/gm)?.length, 2, "exactly one frontmatter block");
  assert.ok(!text.includes("sneaky"));
});

test("a corrupt item is skipped, not fatal — one bad file cannot take the board down", () => {
  const store = new FsBacklogStore(cwd);
  store.write(BacklogItem.parse({ id: "b-good-1", title: "Good", createdAt: clock(), updatedAt: clock() }));
  mkdirSync(join(cwd, ".agentry", "backlog"), { recursive: true });
  writeFileSync(join(cwd, ".agentry", "backlog", "b-broken.md"), "not frontmatter at all");

  const items = store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, "b-good-1");
  assert.equal(store.read("b-broken"), undefined);
});

test("an empty/absent backlog lists as empty rather than throwing", () => {
  assert.deepEqual(new FsBacklogStore(cwd).list(), []);
});

// ── the service ────────────────────────────────────────────────────────────────────────────────────
test("add parks an item in backlog by default, and can queue it directly", () => {
  const s = service();
  assert.equal(s.add({ title: "Parked" }).status, "backlog");
  assert.equal(s.add({ title: "Queued", ready: true }).status, "ready");
});

test("list filters by status", () => {
  const s = service();
  s.add({ title: "One" });
  s.add({ title: "Two", ready: true });
  assert.equal(s.list().length, 2);
  assert.equal(s.list("ready").length, 1);
  assert.equal(s.list("ready")[0]?.title, "Two");
});

test("update is a PATCH — an absent field is left alone, never blanked", () => {
  const s = service();
  const item = s.add({ title: "Original", body: "important context" });
  const moved = s.update({ id: item.id, status: "ready" });
  assert.equal(moved?.status, "ready");
  assert.equal(moved?.body, "important context", "the body survived a status-only patch");
  assert.equal(moved?.title, "Original");
});

test("update on an unknown id reports not-found rather than creating one", () => {
  assert.equal(service().update({ id: "b-ghost", status: "done" }), undefined);
});

// ── the claim loop — the honesty rule (AC18/AC19) ──────────────────────────────────────────────────
test("moving an item to ready starts NOTHING — no run dir appears", () => {
  const s = service();
  const item = s.add({ title: "Queue me" });
  s.update({ id: item.id, status: "ready" });

  const workDir = join(cwd, ".agentry", "work");
  const runs = (() => {
    try {
      return readdirSync(workDir);
    } catch {
      return [];
    }
  })();
  assert.deepEqual(runs, [], "ready is a QUEUE — only an explicit claim mints a run");
});

test("claim mints a run, links it to the item, and marks it claimed", () => {
  const s = service();
  const item = s.add({ title: "Session middleware", ready: true });

  const outcome = s.claim(item.id);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.item.status, "claimed");
  assert.deepEqual(outcome.item.runs, [outcome.run]);
  // The run is a REAL run — same scaffold `run_start` lays down, not a stub.
  assert.ok(readFileSync(join(cwd, ".agentry", "work", outcome.run, "spec.md"), "utf8").length > 0);
});

test("claim with no id takes the item that has waited longest (the queue is FIFO)", () => {
  const s = service();
  const first = s.add({ title: "Waited longest", ready: true });
  s.add({ title: "Newer", ready: true });

  const outcome = s.claim();
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.item.id, first.id);
});

test("claim refuses an item that is not ready, and an empty queue", () => {
  const s = service();
  const parked = s.add({ title: "Not queued" });
  assert.deepEqual(s.claim(parked.id), { ok: false, reason: "not_ready" });
  assert.deepEqual(s.claim("b-ghost"), { ok: false, reason: "not_found" });
  assert.deepEqual(s.claim(), { ok: false, reason: "empty_queue" });
});

test("a second claim of the same item is refused — it is no longer ready", () => {
  const s = service();
  const item = s.add({ title: "Once only", ready: true });
  assert.equal(s.claim(item.id).ok, true);
  assert.deepEqual(s.claim(item.id), { ok: false, reason: "not_ready" });
});

test("isReady is the single predicate the queue reads", () => {
  const s = service();
  assert.equal(isReady(s.add({ title: "a", ready: true })), true);
  assert.equal(isReady(s.add({ title: "b" })), false);
});
