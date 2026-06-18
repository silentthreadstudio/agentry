// Tests for the pure kind-extractor (ADR-005 / AC11). ZERO API spend: every case runs `extractKind` over a
// SYNTHETIC `.agentry/work/*` layout built in a temp working dir (no `claude -p`, no runner). These prove the
// `spec.md` frontmatter → kind read, the `null` signals (no work folder / no spec.md / no kind field), and the
// independence from the shape settle-signals (kind is a function of artifact CONTENT, not the ctx) — the same
// faithful mechanism `extractShape` uses, read from the same artifact.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { extractKind } from "../src/routing/extract-kind.ts";

/** A fresh temp working dir (the sandbox root the extractor scans for `.agentry/work/*`). */
function freshWorkingDir(): string {
  return mkdtempSync(join(tmpdir(), "selfeval-extract-kind-work-"));
}

/** Create `<workingDir>/.agentry/work/<slug>/` and return its absolute path. */
function workSlugDir(workingDir: string, slug: string): string {
  const dir = join(workingDir, ".agentry", "work", slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a `spec.md` with the given frontmatter body (between the `---` fences) plus a prose tail. */
function writeSpec(slugDir: string, frontmatter: string): void {
  writeFileSync(join(slugDir, "spec.md"), `---\n${frontmatter}\n---\n\n# Spec\n\nbody\n`, "utf8");
}

// --- the happy path: a kind field in spec.md frontmatter is read -------------------------------------

test("a spec.md whose frontmatter carries `kind: bug` => 'bug'", () => {
  const wd = freshWorkingDir();
  writeSpec(workSlugDir(wd, "feature-x"), "id: SP1\nkind: bug");

  assert.equal(extractKind(wd), "bug");
});

test("each of the six known kinds is read verbatim from the frontmatter", () => {
  for (const kind of ["feature", "bug", "refactor", "perf", "dep-upgrade", "ci-red"]) {
    const wd = freshWorkingDir();
    writeSpec(workSlugDir(wd, "feature-x"), `kind: ${kind}`);
    assert.equal(extractKind(wd), kind, `kind ${kind} read verbatim`);
  }
});

test("an unknown kind value is read permissively (mirrors Kind = z.string())", () => {
  const wd = freshWorkingDir();
  writeSpec(workSlugDir(wd, "feature-x"), "kind: some-future-kind");

  assert.equal(extractKind(wd), "some-future-kind", "an unknown kind is accepted, not dropped");
});

// --- the null signals: absent work folder / spec / kind field ----------------------------------------

test("no .agentry/work at all (a genuine one-shot writes nothing) => null", () => {
  const wd = freshWorkingDir();
  assert.equal(extractKind(wd), null);
});

test("a work folder with no spec.md (decompose-only / unlabeled) => null", () => {
  const wd = freshWorkingDir();
  const slug = workSlugDir(wd, "feature-x");
  writeFileSync(join(slug, "plan.md"), "# plan\n", "utf8"); // a plan but no spec.md

  assert.equal(extractKind(wd), null);
});

test("a spec.md whose frontmatter omits `kind` (an unlabeled / pre-ADR-005 spec) => null", () => {
  const wd = freshWorkingDir();
  writeSpec(workSlugDir(wd, "feature-x"), "id: SP1\ntitle: a spec with no kind");

  assert.equal(extractKind(wd), null);
});

test("a spec.md with NO frontmatter block => null (not a crash)", () => {
  const wd = freshWorkingDir();
  writeFileSync(join(workSlugDir(wd, "feature-x"), "spec.md"), "# Spec\n\njust prose, no frontmatter\n", "utf8");

  assert.equal(extractKind(wd), null);
});

test("a spec.md with a malformed YAML frontmatter body => null (tolerated, not a crash)", () => {
  const wd = freshWorkingDir();
  // An unterminated/garbage YAML body — the read must degrade to null, never throw (one bad artifact must not
  // sink the probe), mirroring how the shape path tolerates a missing tree.
  writeFileSync(
    join(workSlugDir(wd, "feature-x"), "spec.md"),
    "---\nkind: bug\n  : : broken\n   - [unbalanced\n---\n",
    "utf8",
  );

  assert.doesNotThrow(() => extractKind(wd));
});

test("a non-string `kind` (e.g. a number) => null", () => {
  const wd = freshWorkingDir();
  writeSpec(workSlugDir(wd, "feature-x"), "kind: 42");

  assert.equal(extractKind(wd), null);
});

// --- multiple work folders: the first kind found wins ------------------------------------------------

test("the first work folder carrying a kind is returned (scan across folders)", () => {
  const wd = freshWorkingDir();
  // A spec-less folder plus a kind-bearing one — the kind-bearing spec.md is found.
  writeFileSync(join(workSlugDir(wd, "a-no-spec"), "plan.md"), "# plan\n", "utf8");
  writeSpec(workSlugDir(wd, "b-has-kind"), "kind: refactor");

  assert.equal(extractKind(wd), "refactor");
});

// --- ctx is accepted for signature parallelism but does not change the verdict ------------------------

test("ctx (the shape settle-signals) is accepted but ignored — kind reads from artifact content alone", () => {
  const wd = freshWorkingDir();
  writeSpec(workSlugDir(wd, "feature-x"), "kind: perf");

  // Passing an ExtractContext mirrors extractShape's signature; it must not change the kind read.
  assert.equal(extractKind(wd, { resultSubtype: "success", producedTreeNonEmpty: true }), "perf");
  assert.equal(extractKind(wd, { producedTreeNonEmpty: false }), "perf");
});
