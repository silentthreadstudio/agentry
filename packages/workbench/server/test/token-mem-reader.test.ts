// TokenReader + TranscriptReader + MemReader proof (task 021) — the external-source readers. Two layers:
//  (1) against a FAKE TranscriptSource (TokenReader's fold) and against TEMP fixture trees (TranscriptReader
//      + MemReader's parsing + graceful degrade), so behavior is deterministic with no real home dir;
//  (2) against the REAL mem store under this repo (MemReader acceptance) — the project + global roots.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { TokenSample, TranscriptSource } from "../src/domain/ports.js";
import { TokenReader } from "../src/application/token-reader.js";
import { TranscriptReader } from "../src/persistence/transcript-reader.js";
import { MemReader } from "../src/persistence/mem-reader.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function fakeTranscripts(samples: TokenSample[]): TranscriptSource {
  return { read: () => samples };
}

// ── TokenReader: the per-day cumulative fold ──────────────────────────────────────────────────────────

test("TokenReader buckets samples by UTC day and accumulates", () => {
  const reader = new TokenReader(
    fakeTranscripts([
      { timestamp: "2026-06-18T10:00:00.000Z", tokens: 100 },
      { timestamp: "2026-06-18T18:00:00.000Z", tokens: 50 },
      { timestamp: "2026-06-19T09:00:00.000Z", tokens: 200 },
    ]),
  );
  const series = reader.series("run-a");
  assert.deepEqual(series.timestamps, ["2026-06-18", "2026-06-19"], "two day buckets, sorted");
  assert.deepEqual(series.tokens, [150, 350], "cumulative: 150 then 150+200");
});

test("TokenReader returns a clean empty series when there are no samples (graceful degrade)", () => {
  const reader = new TokenReader(fakeTranscripts([]));
  assert.deepEqual(reader.series("run-a"), { timestamps: [], tokens: [] });
});

// ── TranscriptReader: location/shape verification + graceful degrade ───────────────────────────────────

// Seed a project (the FLOW session pointers) + a fake home (~/.claude/projects/<slug>/<session>.jsonl).
function seedTranscripts(opts: {
  run: string;
  session: string;
  lines: string[];
}): { cwd: string; home: string } {
  const cwd = mkdtempSync(join(tmpdir(), "wb-tx-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "wb-tx-home-"));
  // FLOW session→run pointer
  const ptrDir = join(cwd, ".agentry", "run", "sessions");
  mkdirSync(ptrDir, { recursive: true });
  writeFileSync(join(ptrDir, `${opts.session}.json`), JSON.stringify({ workId: opts.run }));
  // transcript at ~/.claude/projects/<slug>/<session>.jsonl ; slug = cwd with non-alnum → '-'
  const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
  const txDir = join(home, ".claude", "projects", slug);
  mkdirSync(txDir, { recursive: true });
  writeFileSync(join(txDir, `${opts.session}.jsonl`), opts.lines.join("\n"));
  return { cwd, home };
}

test("TranscriptReader resolves a run's sessions and sums message.usage per line", () => {
  const { cwd, home } = seedTranscripts({
    run: "run-a",
    session: "sess-1",
    lines: [
      JSON.stringify({ type: "assistant", timestamp: "2026-06-18T10:00:00.000Z", message: { usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } } }),
      JSON.stringify({ type: "user", timestamp: "2026-06-18T10:01:00.000Z", message: { role: "user" } }), // no usage → skip
      "not json", // malformed → skip
    ],
  });
  try {
    const reader = new TranscriptReader(cwd, home);
    const samples = reader.read("run-a");
    assert.equal(samples.length, 1, "only the assistant-usage line yields a sample");
    assert.equal(samples[0]?.tokens, 20, "10+5+2+3 summed");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("TranscriptReader degrades to empty when the transcript source is absent", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wb-tx-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "wb-tx-home-")); // no ~/.claude/projects at all
  try {
    const reader = new TranscriptReader(cwd, home);
    assert.deepEqual(reader.read("run-a"), [], "no pointers + no transcript dir → empty, no throw");
    // And folded through TokenReader → a clean empty series.
    assert.deepEqual(new TokenReader(reader).series("run-a"), { timestamps: [], tokens: [] });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ── MemReader: read-only browse/search over both roots ────────────────────────────────────────────────

function seedMem(): { cwd: string; home: string } {
  const cwd = mkdtempSync(join(tmpdir(), "wb-mem-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "wb-mem-home-"));
  // global fact
  const gFacts = join(home, ".agentry", "memory", "facts");
  mkdirSync(gFacts, { recursive: true });
  writeFileSync(join(gFacts, "use-vitest-01h.md"), "---\nid: 01h\nscope: global\n---\n\nThe repo uses Vitest, not Jest.\n");
  // project episode
  const pEps = join(cwd, ".agentry", "memory", "episodes");
  mkdirSync(pEps, { recursive: true });
  writeFileSync(join(pEps, "ran-migrations-02k.md"), "---\nid: 02k\n---\n\nMigrations must run before the seed script.\n");
  // a corrupt file (no frontmatter fence) → skipped
  const gEps = join(home, ".agentry", "memory", "episodes");
  mkdirSync(gEps, { recursive: true });
  writeFileSync(join(gEps, "broken-03z.md"), "no fence here, just text\n");
  return { cwd, home };
}

test("MemReader browses facts + episodes across both roots, tagging kind + origin", () => {
  const { cwd, home } = seedMem();
  try {
    const reader = new MemReader(cwd, home);
    const all = reader.list();
    // global fact + project episode kept; the fence-less file skipped.
    assert.equal(all.length, 2, "two valid records, the corrupt one skipped");
    const fact = all.find((r) => r.id === "01h");
    assert.equal(fact?.kind, "facts");
    assert.equal(fact?.origin, "global");
    assert.match(String(fact?.fields.text), /Vitest/, "the body prose is attached under 'text'");
    const episode = all.find((r) => r.id === "02k");
    assert.equal(episode?.kind, "episodes");
    assert.equal(episode?.origin, "project");
    assert.match(String(episode?.fields.task), /Migrations/, "the episode body attached under 'task'");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("MemReader.search filters by substring across body + frontmatter (read-only)", () => {
  const { cwd, home } = seedMem();
  try {
    const reader = new MemReader(cwd, home);
    assert.equal(reader.search("vitest").length, 1, "case-insensitive body match");
    assert.equal(reader.search("migrations").length, 1, "matches the episode body");
    assert.equal(reader.search("nonexistent-xyz").length, 0, "no match → empty");
    assert.equal(reader.search("").length, 2, "empty query → full browse");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("MemReader on the REAL repo mem store reads records without writing (acceptance)", () => {
  // The real project root (REPO_ROOT) has a `.agentry/memory` if memory has been written here; the global
  // root is the real home. The read must not throw and returns an array (possibly empty in a clean env).
  const reader = new MemReader(REPO_ROOT);
  const all = reader.list();
  assert.ok(Array.isArray(all), "list() returns an array over the real roots, no throw");
  for (const r of all) {
    assert.ok(r.kind === "facts" || r.kind === "episodes");
    assert.ok(r.origin === "global" || r.origin === "project");
  }
});
