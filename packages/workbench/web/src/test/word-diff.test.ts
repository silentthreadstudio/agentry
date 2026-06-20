// word-diff — the token-level before/after diff that feeds DiffDrawer's panes (task 19). These assert the
// observable op stream: shared text is `equal`, removed-only text is `del`, added-only text is `add`, and
// re-joining the ops reproduces each side exactly (no lost whitespace — the property the panes rely on).
import assert from "node:assert/strict";
import { test } from "node:test";
import { isUnchanged, wordDiff } from "../routes/work/live/doc/word-diff.js";

// Re-join the ops as the `before` side sees them (equal + del) and the `after` side (equal + add).
function rebuildBefore(ops: ReturnType<typeof wordDiff>): string {
  return ops.filter((o) => o.kind !== "add").map((o) => o.text).join("");
}
function rebuildAfter(ops: ReturnType<typeof wordDiff>): string {
  return ops.filter((o) => o.kind !== "del").map((o) => o.text).join("");
}

test("identical bodies produce only equal ops (nothing to highlight)", () => {
  const ops = wordDiff("the events stream", "the events stream");
  assert.ok(ops.every((o) => o.kind === "equal"));
  assert.ok(isUnchanged("the events stream", "the events stream"));
});

test("a replaced word shows as a del then an add, sharing the surrounding text", () => {
  const ops = wordDiff("the shape is decompose only", "the shape is decompose+verify only");
  assert.ok(ops.some((o) => o.kind === "del"));
  assert.ok(ops.some((o) => o.kind === "add"));
  // the unchanged framing words stay equal
  assert.ok(ops.some((o) => o.kind === "equal" && o.text.includes("the shape is")));
  assert.ok(ops.some((o) => o.kind === "equal" && o.text.includes("only")));
});

test("the before/after panes each rebuild their full side from the ops (no lost whitespace)", () => {
  const before = "One append-only events.jsonl; the hook demotes to a backstop.";
  const after = "One append-only events.jsonl with a CLOSED discriminated type; the hook stays a backstop.";
  const ops = wordDiff(before, after);
  assert.equal(rebuildBefore(ops), before);
  assert.equal(rebuildAfter(ops), after);
});

test("pure insertion (empty before) is all add; pure deletion (empty after) is all del", () => {
  assert.ok(wordDiff("", "brand new line").every((o) => o.kind === "add"));
  assert.ok(wordDiff("old removed line", "").every((o) => o.kind === "del"));
});

test("consecutive same-kind ops are coalesced into runs, not per-token fragments", () => {
  const ops = wordDiff("a b c", "a x y z c");
  // between the shared "a " and "c", the additions "x y z " should be ONE add run.
  const adds = ops.filter((o) => o.kind === "add");
  assert.equal(adds.length, 1, "added tokens coalesce into a single run");
});
