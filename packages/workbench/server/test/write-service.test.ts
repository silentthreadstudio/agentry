// WriteService proof — the clobber-safety boundary (task 015, ADR-006). All five invariants are
// proven against a FAKE FlowWriterPort (no fs, no ws — the port purity ADR-001 buys), so the lock +
// optimistic-concurrency gates are tested as observable behavior, not implementation:
//   AC6 — a stale `baseVersion` is rejected; a fresh write bumps the version.
//   AC4 — a write against `status===in-progress` is rejected with `lockedBy`; `takeOver` flips the
//         lock, after which the write is allowed.
//   AC5 — `addComment` appends a valid `ReviewComment` (3-way anchor) even when the doc is locked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeVersion } from "@agentry/flow/domain/version";
import { ReviewComment } from "@agentry/flow/domain/review";
import { WriteService } from "../src/application/write-service.js";
import type {
  ArtifactTarget,
  CurrentArtifact,
  FlowWriterPort,
} from "../src/persistence/flow-writer.js";

// A fake writer backing the two surfaces in memory. Artifacts are keyed by their target; the version
// is computed the SAME way the real adapter does (FLOW's `computeVersion` over frontmatter-sans-
// version + body), so the service's freshness check sees the true post-write version — the fake is a
// faithful stand-in, not a stub that hard-codes the answer the test wants.
interface StoredArtifact {
  frontmatter: Record<string, unknown>; // WITHOUT `version` (the way the hash sees it)
  body: string;
}

function targetKey(target: ArtifactTarget): string {
  return "kind" in target ? `kind:${target.kind}` : `task:${target.taskNo}`;
}

function fakeWriter(seed: Record<string, StoredArtifact> = {}) {
  const store = new Map<string, StoredArtifact>(Object.entries(seed));
  const comments: { run: string; gate: string; comment: ReviewComment }[] = [];

  const port: FlowWriterPort = {
    readArtifact(_run, target): CurrentArtifact | undefined {
      const stored = store.get(targetKey(target));
      if (stored === undefined) return undefined;
      const { version: _drop, ...sans } = stored.frontmatter;
      return {
        frontmatter: sans,
        body: stored.body,
        version: computeVersion(stored.body, sans),
      };
    },
    writeArtifact(_run, target, frontmatter, body): string {
      const { version: _drop, ...sans } = frontmatter;
      store.set(targetKey(target), { frontmatter: sans, body });
      return computeVersion(body, sans);
    },
    appendComment(run, gate, comment): void {
      comments.push({ run, gate, comment });
    },
    resolveComment(_run, gate, commentId): boolean {
      const hit = comments.find((c) => c.gate === gate && c.comment.id === commentId);
      if (!hit) return false;
      hit.comment = { ...hit.comment, resolved: true };
      return true;
    },
  };

  return { port, store, comments };
}

const ANCHOR = { originalText: "the snippet", headingAnchor: "## Section", startLine: 3 };

// ── Resolve persistence (VISION §6 — survives reload) ────────────────────────────────────────────────

test("resolveComment flips a comment by id; ok:false for an unknown id", () => {
  const fake = fakeWriter();
  const svc = new WriteService(fake.port);
  const { id } = svc.addComment({
    run: "r",
    gate: "spec",
    anchor: ANCHOR,
    decision: "changes",
    body: "please fix",
  });

  assert.equal(svc.resolveComment({ run: "r", gate: "spec", commentId: id }).ok, true);
  assert.equal(fake.comments.find((c) => c.comment.id === id)?.comment.resolved, true);
  // An id that was never written cannot be resolved.
  assert.equal(svc.resolveComment({ run: "r", gate: "spec", commentId: "nope" }).ok, false);
});

// ── AC6: optimistic concurrency ─────────────────────────────────────────────────────────────────────

test("writeArtifact rejects a stale baseVersion (optimistic concurrency, AC6)", () => {
  const fake = fakeWriter({
    "kind:spec": { frontmatter: { kind: "spec" }, body: "# Spec\n\noriginal" },
  });
  const svc = new WriteService(fake.port);

  const outcome = svc.writeArtifact({
    run: "r",
    target: { kind: "spec" },
    baseVersion: "deadbeefdeadbeef", // not the on-disk version → someone wrote in between
    newBody: "# Spec\n\nmy edit",
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, "stale");
  // The body on disk is untouched by a rejected write.
  assert.equal(fake.store.get("kind:spec")?.body, "# Spec\n\noriginal");
});

test("writeArtifact with a fresh baseVersion writes and bumps the version (AC6)", () => {
  const front = { kind: "plan" };
  const body = "# Plan\n\noriginal";
  const fake = fakeWriter({ "kind:plan": { frontmatter: front, body } });
  const svc = new WriteService(fake.port);

  const baseVersion = computeVersion(body, front); // the opaque token the client was handed on open
  const outcome = svc.writeArtifact({
    run: "r",
    target: { kind: "plan" },
    baseVersion,
    newBody: "# Plan\n\nmy edit",
  });

  assert.equal(outcome.ok, true);
  const newVersion = outcome.ok === true ? outcome.version : "";
  assert.notEqual(newVersion, baseVersion, "the version is re-stamped on a body edit");
  assert.equal(fake.store.get("kind:plan")?.body, "# Plan\n\nmy edit", "the new body is written");
  // The returned version is the true content-hash of what was written (freshness key is real).
  assert.equal(newVersion, computeVersion("# Plan\n\nmy edit", front));
});

test("writeArtifact returns not-found when the artifact is absent", () => {
  const svc = new WriteService(fakeWriter().port);
  const outcome = svc.writeArtifact({
    run: "r",
    target: { kind: "spec" },
    baseVersion: "whatever",
    newBody: "x",
  });
  assert.equal(outcome.ok === false && outcome.reason, "not-found");
});

// ── AC4: the lock + take-over ─────────────────────────────────────────────────────────────────────

test("writeArtifact against status===in-progress is rejected with lockedBy (AC4)", () => {
  const front = { title: "T", status: "in-progress", lockedBy: "implementer" };
  const body = "## meta\n\nthe task";
  const fake = fakeWriter({ "task:015": { frontmatter: front, body } });
  const svc = new WriteService(fake.port);

  const outcome = svc.writeArtifact({
    run: "r",
    target: { taskNo: "015" },
    baseVersion: computeVersion(body, front), // fresh — proving the LOCK, not staleness, rejects
    newBody: "## meta\n\nmy edit",
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, "locked");
  assert.equal(outcome.ok === false && outcome.reason === "locked" && outcome.lockedBy, "implementer");
  assert.equal(fake.store.get("task:015")?.body, body, "a locked doc is not written");
});

test("takeOver flips the lock, then the write is allowed (AC4)", () => {
  const front = { title: "T", status: "in-progress", lockedBy: "implementer" };
  const body = "## meta\n\nthe task";
  const fake = fakeWriter({ "task:015": { frontmatter: front, body } });
  const svc = new WriteService(fake.port);

  // 1. Take over — the explicit server lock transition (the human claims the edit).
  const takeover = svc.takeOver({ run: "r", taskNo: "015", by: "human" });
  assert.equal(takeover.ok, true);

  // The lock is released and the body is byte-identical (the take-over flips frontmatter only).
  const after = fake.store.get("task:015");
  assert.equal(after?.frontmatter.status, "in-review", "status moved off in-progress");
  assert.equal(after?.frontmatter.lockedBy, "human", "the human now holds the lock");
  assert.equal(after?.body, body, "take-over does not alter the prose");

  // 2. The write now passes the lock gate (fresh baseVersion against the post-take-over state).
  const fresh = computeVersion(body, { title: "T", status: "in-review", lockedBy: "human" });
  const outcome = svc.writeArtifact({
    run: "r",
    target: { taskNo: "015" },
    baseVersion: fresh,
    newBody: "## meta\n\nedited after take-over",
  });

  assert.equal(outcome.ok, true, "the write is allowed after take-over");
  assert.equal(fake.store.get("task:015")?.body, "## meta\n\nedited after take-over");
});

test("takeOver returns not-found for an absent task", () => {
  const svc = new WriteService(fakeWriter().port);
  const outcome = svc.takeOver({ run: "r", taskNo: "099", by: "human" });
  assert.equal(outcome.ok === false && outcome.reason, "not-found");
});

// ── AC5: comments are allowed even when locked ──────────────────────────────────────────────────────

test("addComment appends a valid ReviewComment even when the doc is locked (AC5)", () => {
  // The task IS locked (in-progress) — addComment never consults the lock; annotations are always OK.
  const fake = fakeWriter({
    "task:015": {
      frontmatter: { title: "T", status: "in-progress", lockedBy: "implementer" },
      body: "the task",
    },
  });
  const svc = new WriteService(fake.port);

  const { id } = svc.addComment({
    run: "r",
    gate: "plan",
    anchor: ANCHOR,
    decision: "changes",
    body: "please reconsider this",
  });

  assert.equal(fake.comments.length, 1, "one comment appended");
  const appended = fake.comments[0];
  assert.equal(appended.run, "r");
  assert.equal(appended.gate, "plan");
  // The appended comment is a VALID ReviewComment with the 3-way anchor, open by default, id minted.
  const validated = ReviewComment.parse(appended.comment);
  assert.equal(validated.id, id, "the minted id is returned to the caller");
  assert.equal(validated.resolved, false, "a fresh comment is open");
  assert.deepEqual(validated.anchor, ANCHOR, "the 3-way anchor is carried through");
  assert.equal(validated.decision, "changes");
});
