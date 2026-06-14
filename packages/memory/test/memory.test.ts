import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Fact } from "@agentry/core";
import { MemoryService } from "../src/application/memory-service.js";
import { SqliteTextIndex } from "../src/persistence/db-index.js";
import { MarkdownFileStore } from "../src/persistence/file-store.js";
import type { Roots } from "../src/resolution/roots.js";

function newService(global: string, now?: () => number): MemoryService {
  const roots: Roots = { global, project: null };
  const service = new MemoryService(new MarkdownFileStore(roots), new SqliteTextIndex(), roots, now);
  service.load();
  return service;
}

const fresh = (): string => mkdtempSync(join(tmpdir(), "agentry-mem-"));

// Read a fact (any status — including archived) straight off disk, the file store being truth. Lets a
// test inspect tombstone fields (decay/status/archivedAt) that recall/search deliberately don't expose.
function factOnDisk(global: string, id: string): Fact | undefined {
  const store = new MarkdownFileStore({ global, project: null });
  return store.readFacts().records.find((r) => r.fact.id === id)?.fact;
}

test("write → recall round-trips", () => {
  const service = newService(fresh());
  const { id, action } = service.write({
    type: "gotcha",
    scope: "global",
    text: "esbuild must mark node:sqlite external when bundling",
  });
  assert.equal(action, "created");
  const { memories } = service.recall({ query: "esbuild sqlite external" });
  assert.equal(memories.length, 1);
  assert.equal(memories[0]?.fact.id, id);
});

test("dedup-reinforce: a near-duplicate reinforces, not duplicates", () => {
  const service = newService(fresh());
  service.write({ type: "preference", scope: "global", text: "always use pnpm for installs in this repo" });
  const second = service.write({
    type: "preference",
    scope: "global",
    text: "always use pnpm for installs in this repo",
  });
  assert.equal(second.action, "reinforced");
  assert.equal(service.stats().active, 1);
});

test("rebuild-on-start: a fresh service reads the files (text = truth)", () => {
  const dir = fresh();
  newService(dir).write({
    type: "decision",
    scope: "global",
    text: "memory is text-as-truth with a derived sqlite index",
  });
  const restarted = newService(dir); // simulates a session restart
  const { memories } = restarted.recall({ query: "text-as-truth sqlite index" });
  assert.equal(memories.length, 1);
});

test("supersede: recall returns only the active fact", () => {
  const service = newService(fresh());
  const first = service.write({
    type: "repo-fact",
    scope: "global",
    text: "the auth module lives under src server handlers",
  });
  service.write({
    type: "repo-fact",
    scope: "global",
    text: "the auth module moved to packages identity adapters",
    supersedes: first.id,
  });
  const { memories } = service.recall({ query: "auth module location" });
  assert.equal(memories.length, 1);
  assert.match(memories[0]?.fact.text ?? "", /identity adapters/);
});

test("forget: removes a memory from the store and disk", () => {
  const service = newService(fresh());
  const { id } = service.write({
    type: "gotcha",
    scope: "global",
    text: "this temporary fact will be forgotten shortly",
  });
  assert.equal(service.stats().active, 1);
  assert.deepEqual(service.forget(id), { ok: true, id, kind: "fact" });
  assert.equal(service.stats().facts, 0);
  assert.equal(service.recall({ query: "temporary forgotten fact" }).memories.length, 0);
  assert.equal(service.forget(id).ok, false); // idempotent — now a not-found outcome
});

const ARCHIVE_THRESHOLD = 4; // mirrors the service constant (doc 02 §7 benchmark knob)

test("decay → archive: recalled-but-unused crosses the strike threshold and self-archives", () => {
  const dir = fresh();
  let clock = 1_000;
  const service = newService(dir, () => clock);
  const { id } = service.write({
    type: "gotcha",
    scope: "global",
    text: "this fact will be recalled but never used and should self-archive",
  });

  // strikes 1..THRESHOLD-1 accrue without archiving; usefulness floors at 0 along the way
  for (let strike = 1; strike < ARCHIVE_THRESHOLD; strike++) {
    clock += 1_000;
    service.feedback({ recalled: [id], used: [], outcome: "pass" });
    const f = factOnDisk(dir, id);
    assert.equal(f?.status, "active");
    assert.equal(f?.decay, strike);
    assert.equal(f?.usefulness, 0); // floored
  }

  clock += 1_000;
  service.feedback({ recalled: [id], used: [], outcome: "pass" }); // the strike that crosses
  const archived = factOnDisk(dir, id);
  assert.equal(archived?.status, "archived");
  assert.equal(archived?.usefulness, 0);
  assert.equal(archived?.decay, ARCHIVE_THRESHOLD);
  assert.ok(archived?.archivedAt, "archivedAt tombstone is set");

  // excluded from recall in both modes
  assert.equal(service.recall({ query: "recalled never used self-archive" }).memories.length, 0);
  assert.equal(
    service.recall({ mode: "prime" }).memories.some((m) => m.fact.id === id),
    false,
  );
});

test("decay reset: a cite+pass clears strikes and prevents archive", () => {
  const dir = fresh();
  let clock = 1_000;
  const service = newService(dir, () => clock);
  const { id } = service.write({
    type: "gotcha",
    scope: "global",
    text: "this fact gets recalled-unused thrice then cited so it survives",
  });

  for (let strike = 1; strike < ARCHIVE_THRESHOLD; strike++) {
    clock += 1_000;
    service.feedback({ recalled: [id], used: [], outcome: "pass" });
  }
  assert.equal(factOnDisk(dir, id)?.decay, ARCHIVE_THRESHOLD - 1);

  clock += 1_000;
  service.feedback({ recalled: [id], used: [id], outcome: "pass" }); // cite + pass resets
  assert.equal(factOnDisk(dir, id)?.decay, 0);

  // a further recalled-unused strike does not archive (counter restarted from 0)
  clock += 1_000;
  service.feedback({ recalled: [id], used: [], outcome: "pass" });
  assert.equal(factOnDisk(dir, id)?.status, "active");
});

test("recover: a tombstoned fact returns to active and is recallable again without a reload", () => {
  const dir = fresh();
  let clock = 1_000;
  const service = newService(dir, () => clock);
  const { id } = service.write({
    type: "gotcha",
    scope: "global",
    text: "archive me then recover me back into the search index",
  });
  for (let strike = 1; strike <= ARCHIVE_THRESHOLD; strike++) {
    clock += 1_000;
    service.feedback({ recalled: [id], used: [], outcome: "pass" });
  }
  assert.equal(factOnDisk(dir, id)?.status, "archived");

  assert.deepEqual(service.recover(id), { ok: true, id });
  const recovered = factOnDisk(dir, id);
  assert.equal(recovered?.status, "active");
  assert.equal(recovered?.decay, 0);
  assert.equal(recovered?.archivedAt, undefined);

  // recall (task mode) finds it again — recover re-added it to the text index in-process
  const { memories } = service.recall({ query: "recover me back into the search index" });
  assert.equal(memories.some((m) => m.fact.id === id), true);

  // recover on an already-active id → invalid-state (it exists but isn't archived); unknown id → not-found
  const reRecover = service.recover(id);
  assert.equal(reRecover.ok, false);
  assert.equal(reRecover.ok === false && reRecover.reason, "invalid-state");
  const missing = service.recover("p:nonexistent");
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.reason, "not-found");
});

test("feedback ignores non-active ids: a superseded fact can never be decayed or archived", () => {
  const dir = fresh();
  let clock = 1_000;
  const service = newService(dir, () => clock);
  const first = service.write({
    type: "repo-fact",
    scope: "global",
    text: "the config loader lives under src config legacy path",
  });
  clock += 1_000;
  service.write({
    type: "repo-fact",
    scope: "global",
    text: "the config loader moved to packages config modern path",
    supersedes: first.id,
  });
  assert.equal(factOnDisk(dir, first.id)?.status, "superseded");

  // feed the superseded id back as recalled-but-unused past the threshold — supersession is terminal,
  // so it must stay superseded with its strike counter untouched (never flips to archived).
  for (let strike = 1; strike <= ARCHIVE_THRESHOLD; strike++) {
    clock += 1_000;
    service.feedback({ recalled: [first.id], used: [], outcome: "pass" });
  }
  const stillSuperseded = factOnDisk(dir, first.id);
  assert.equal(stillSuperseded?.status, "superseded");
  assert.equal(stillSuperseded?.decay, 0, "decay counter never advanced on a non-active fact");

  // and recover() cannot resurrect it (it exists but isn't archived → invalid-state, not not-found)
  const rec = service.recover(first.id);
  assert.equal(rec.ok, false);
  assert.equal(rec.ok === false && rec.reason, "invalid-state");
  assert.equal(factOnDisk(dir, first.id)?.status, "superseded");
});

test("feedback ignores non-active ids: an archived fact is not further mutated", () => {
  const dir = fresh();
  let clock = 1_000;
  const service = newService(dir, () => clock);
  const { id } = service.write({
    type: "gotcha",
    scope: "global",
    text: "archive me then feed me back as recalled to confirm no further mutation",
  });
  for (let strike = 1; strike <= ARCHIVE_THRESHOLD; strike++) {
    clock += 1_000;
    service.feedback({ recalled: [id], used: [], outcome: "pass" });
  }
  const archived = factOnDisk(dir, id);
  assert.equal(archived?.status, "archived");
  const decayAtArchive = archived?.decay;

  clock += 1_000;
  service.feedback({ recalled: [id], used: [], outcome: "pass" });
  const after = factOnDisk(dir, id);
  assert.equal(after?.status, "archived");
  assert.equal(after?.decay, decayAtArchive, "archived fact's strike counter is left untouched");
});

test("recover is idempotent in the index: a recovered fact appears exactly once in recall", () => {
  const dir = fresh();
  let clock = 1_000;
  const service = newService(dir, () => clock);
  const { id } = service.write({
    type: "gotcha",
    scope: "global",
    text: "archive recover and prove this unique phrase resolves to a single index row",
  });
  for (let strike = 1; strike <= ARCHIVE_THRESHOLD; strike++) {
    clock += 1_000;
    service.feedback({ recalled: [id], used: [], outcome: "pass" });
  }
  assert.deepEqual(service.recover(id), { ok: true, id });

  // task-mode recall returns the fact exactly once (count, not .some — the double-index bug would
  // have surfaced two scored entries for the same id, consuming two of the ranked slots).
  const { memories } = service.recall({ query: "unique phrase resolves single index row" });
  assert.equal(memories.filter((m) => m.fact.id === id).length, 1);

  // the raw index (observed via search(), one entry per index hit) returns a single row for the id.
  const hits = service.search("unique phrase resolves single index row").filter((h) => h.id === id);
  assert.equal(hits.length, 1, "exactly one index row for the recovered fact");
});

test("stats: archived facts count in the archived bucket, not superseded", () => {
  const dir = fresh();
  let clock = 1_000;
  const service = newService(dir, () => clock);
  const { id } = service.write({
    type: "gotcha",
    scope: "global",
    text: "a fact that will end up in the archived stats bucket",
  });
  service.write({ type: "decision", scope: "global", text: "an active fact that stays put" });
  for (let strike = 1; strike <= ARCHIVE_THRESHOLD; strike++) {
    clock += 1_000;
    service.feedback({ recalled: [id], used: [], outcome: "pass" });
  }
  const stats = service.stats();
  assert.equal(stats.archived, 1);
  assert.equal(stats.superseded, 0);
  assert.equal(stats.active, 1);
});

test("episode_write + stats tracks undistilled debt", () => {
  const service = newService(fresh());
  service.episodeWrite({
    task: "build the memory mcp",
    shape: "decompose+verify",
    outcome: "pass",
    lesson: "node:sqlite is flag-free only on Node 24",
  });
  assert.equal(service.stats().undistilled, 1);
});
