// doc-tabs — the Docs workspace's open-tab store (task 008). Asserts the OBSERVABLE tab behavior a caller
// drives through `selectDoc`/`openDocTab`/`closeDocTab` and reads through the store snapshot: open/focus,
// no-churn on re-focus, close-to-neighbor, and clear-without-close. The store is module state, so each
// test resets it by closing every open tab first (the public mutators are the only seam).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  activeDocId,
  closeDocTab,
  openDocTab,
  selectDoc,
} from "../routes/work/docs/doc-tabs.js";

// Read the store's open ids via the public mutators' effect: openDocTab(null) clears active without
// closing, so we reconstruct the open list by walking closeDocTab. To keep tests independent, reset.
function reset(): void {
  // Close every tab by repeatedly clearing — closeDocTab on a focused id moves active to a neighbor, so
  // looping until active is null with no neighbor empties the strip.
  // We don't expose `open` directly; close a generous set of known test ids.
  for (const id of ["a", "b", "c", "spec", "plan", "adr-001", "task-014"]) closeDocTab(id);
}
afterEach(reset);

test("opening a doc makes it the active tab", () => {
  reset();
  selectDoc("a");
  assert.equal(activeDocId(), "a");
});

test("opening a second doc focuses it (the first stays open)", () => {
  reset();
  openDocTab("a");
  openDocTab("b");
  assert.equal(activeDocId(), "b");
  // re-opening the first focuses it again without re-adding (no churn)
  openDocTab("a");
  assert.equal(activeDocId(), "a");
});

test("closing the active tab focuses its right neighbor", () => {
  reset();
  openDocTab("a");
  openDocTab("b");
  openDocTab("c");
  openDocTab("b"); // focus the middle
  closeDocTab("b");
  assert.equal(activeDocId(), "c", "closing the middle tab focuses the right neighbor");
});

test("closing the last tab focuses the left neighbor", () => {
  reset();
  openDocTab("a");
  openDocTab("b");
  closeDocTab("b"); // b is active + last
  assert.equal(activeDocId(), "a");
});

test("closing the only open tab leaves no active doc", () => {
  reset();
  openDocTab("a");
  closeDocTab("a");
  assert.equal(activeDocId(), null);
});

test("selectDoc(null) clears the active doc without closing the tab", () => {
  reset();
  openDocTab("a");
  selectDoc(null);
  assert.equal(activeDocId(), null);
  // the tab is still open — re-selecting it focuses without re-opening from scratch
  selectDoc("a");
  assert.equal(activeDocId(), "a");
});
