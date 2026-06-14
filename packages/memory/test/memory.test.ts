import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryService } from "../src/application/memory-service.js";
import { SqliteTextIndex } from "../src/persistence/db-index.js";
import { MarkdownFileStore } from "../src/persistence/file-store.js";
import type { Roots } from "../src/resolution/roots.js";

function newService(global: string): MemoryService {
  const roots: Roots = { global, project: null };
  const service = new MemoryService(new MarkdownFileStore(roots), new SqliteTextIndex(), roots);
  service.load();
  return service;
}

const fresh = (): string => mkdtempSync(join(tmpdir(), "agentry-mem-"));

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
