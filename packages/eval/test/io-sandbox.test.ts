// Tests for `seedSandbox` and `producedTreeNonEmpty` (io/sandbox.ts) — the recursive copy that plants a
// realistic starting codebase into a prepared working dir BEFORE a run, and the OQ1 one-shot disambiguator's
// tree-signal walk. Pure fs, ZERO API spend: builds fixture trees in temp dirs and asserts directly.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AUTOPILOT_ENV, prepareSandbox, producedTreeNonEmpty, seedSandbox } from "../src/io/sandbox.ts";

/** Build a small nested seed tree on disk and return its root. */
function makeSeedTree(): string {
  const root = mkdtempSync(join(tmpdir(), "selfeval-seed-src-"));
  mkdirSync(join(root, "src", "nested"), { recursive: true });
  writeFileSync(join(root, "package.json"), `{"name":"seed"}`, "utf8");
  writeFileSync(join(root, "src", "index.js"), "export const x = 1;\n", "utf8");
  writeFileSync(join(root, "src", "nested", "deep.js"), "export const y = 2;\n", "utf8");
  return root;
}

test("seedSandbox copies a nested fixture tree into the working dir with content intact", () => {
  const seedDir = makeSeedTree();
  const workingDir = mkdtempSync(join(tmpdir(), "selfeval-seed-work-"));

  seedSandbox(workingDir, seedDir);

  assert.equal(readFileSync(join(workingDir, "package.json"), "utf8"), `{"name":"seed"}`);
  assert.equal(readFileSync(join(workingDir, "src", "index.js"), "utf8"), "export const x = 1;\n");
  assert.equal(readFileSync(join(workingDir, "src", "nested", "deep.js"), "utf8"), "export const y = 2;\n");
});

test("prepareSandbox sets AGENTRY_AUTOPILOT=1 in the child env (decide-record-proceed)", () => {
  // The conductor reads this to run in auto-pilot and emit its work-folder routing artifacts (autopilot §1/§3).
  const sandbox = prepareSandbox();
  assert.equal(sandbox.env[AUTOPILOT_ENV], "1");
});

// --- producedTreeNonEmpty: the OQ1 one-shot tree signal, walking the REAL workingDir -------------------
// The harness tees its OWN bookkeeping into the same workingDir the conductor runs in: the live runner
// writes `stream.jsonl` at the workingDir root, and the primer hook writes `.agentry/work/<slug>/events.jsonl`.
// Those are NOT the conductor's produced tree — only the conductor's edits/artifacts are. So a workingDir
// holding ONLY harness bookkeeping must read as EMPTY (else extractShape's degenerate guard is dead).

/** A fresh, empty temp working dir (the sandbox root the produced-tree walk inspects). */
function freshWorkingDir(): string {
  return mkdtempSync(join(tmpdir(), "selfeval-produced-tree-"));
}

test("a workingDir holding ONLY harness bookkeeping (stream.jsonl + primer events.jsonl) => empty produced tree", () => {
  const wd = freshWorkingDir();
  // The live runner's teed event stream, at the workingDir root.
  writeFileSync(join(wd, "stream.jsonl"), '{"type":"system"}\n', "utf8");
  // The primer hook's own log, under .agentry/work/<slug>/.
  const slug = join(wd, ".agentry", "work", "some-task");
  mkdirSync(slug, { recursive: true });
  writeFileSync(join(slug, "events.jsonl"), '{"event":"primer"}\n', "utf8");

  assert.equal(producedTreeNonEmpty(wd), false);
});

test("a workingDir with a conductor work-folder artifact (spec.md) => non-empty produced tree", () => {
  const wd = freshWorkingDir();
  // Harness bookkeeping present too — but the conductor's spec.md is real signal and must still count.
  writeFileSync(join(wd, "stream.jsonl"), '{"type":"system"}\n', "utf8");
  const slug = join(wd, ".agentry", "work", "some-task");
  mkdirSync(slug, { recursive: true });
  writeFileSync(join(slug, "events.jsonl"), '{"event":"primer"}\n', "utf8");
  writeFileSync(join(slug, "spec.md"), "# spec\n", "utf8");

  assert.equal(producedTreeNonEmpty(wd), true);
});

test("a workingDir with a conductor CODE edit (a sandbox source file) => non-empty produced tree", () => {
  const wd = freshWorkingDir();
  writeFileSync(join(wd, "stream.jsonl"), '{"type":"system"}\n', "utf8");
  // A genuine one-shot leaves real code edits in the sandbox — those must count as produced.
  mkdirSync(join(wd, "src"), { recursive: true });
  writeFileSync(join(wd, "src", "index.js"), "export const x = 1;\n", "utf8");

  assert.equal(producedTreeNonEmpty(wd), true);
});

test("an events.jsonl in a SIBLING of .agentry/work (e.g. .agentry/workspace) STILL counts as produced output", () => {
  // The primer-log exclusion is scoped to the `.agentry/work/` subtree via a `startsWith(workSubtreeAbs + sep)`
  // guard. The trailing separator is load-bearing: it prevents the prefix from leaking onto a SIBLING dir whose
  // path shares the `.agentry/work` prefix (`.agentry/workspace`, `.agentry/work-tmp`, …). An events.jsonl there is
  // genuine conductor output, NOT harness bookkeeping, so it must read as a non-empty produced tree.
  const wd = freshWorkingDir();
  writeFileSync(join(wd, "stream.jsonl"), '{"type":"system"}\n', "utf8");
  const sibling = join(wd, ".agentry", "workspace", "some-task");
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "events.jsonl"), '{"event":"real-output"}\n', "utf8");

  assert.equal(producedTreeNonEmpty(wd), true);
});
