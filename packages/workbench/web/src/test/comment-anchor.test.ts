// comment-anchor — the 3-way anchor the comment loop builds for a span (task 18, AC5), and the proof that
// the `comment` MARK serializes to nothing (a commented body round-trips unchanged through task 14's
// serializer). These cover the pure core (`computeAnchor`) and the serializer contract — the DOM adapter
// (`buildAnchor`) is a thin structure-reader over the same core.
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeAnchor } from "../routes/work/live/doc/anchor.js";
import { tiptapToMd, type ProseMirrorDoc } from "../routes/work/live/doc/markdown-serializer.js";

// A doc rendered as blocks: h1 title, an h2 section, a paragraph under it, a second h2, a paragraph.
const BLOCKS = [
  { tag: "H1", text: "T03 — Monitoring · events" },
  { tag: "H2", text: "exposes" },
  { tag: "P", text: "run_start · event_emit · run_status." },
  { tag: "H2", text: "brief" },
  { tag: "P", text: "The conductor's lifecycle event stream." },
];

test("originalText is the exact selected span", () => {
  const anchor = computeAnchor(BLOCKS, 2, "event_emit");
  assert.equal(anchor.originalText, "event_emit");
});

test("headingAnchor is the nearest ## heading AT OR ABOVE the selected block", () => {
  // selecting inside the paragraph under "brief" (index 4) anchors to "brief", not "exposes".
  assert.equal(computeAnchor(BLOCKS, 4, "lifecycle").headingAnchor, "brief");
  // selecting inside the paragraph under "exposes" (index 2) anchors to "exposes".
  assert.equal(computeAnchor(BLOCKS, 2, "run_status").headingAnchor, "exposes");
});

test("startLine is the 1-based block index of the selection", () => {
  assert.equal(computeAnchor(BLOCKS, 0, "T03").startLine, 1);
  assert.equal(computeAnchor(BLOCKS, 4, "lifecycle").startLine, 5);
});

test("a selection above any ## falls back to the h1 title; an unknown block falls back to line 1", () => {
  // index 0 is the h1 itself — no h2 at/above → falls back to the first h2 in the doc (the prototype's
  // behaviour: there's always a section to anchor to once one exists).
  assert.equal(computeAnchor(BLOCKS, 0, "T03").headingAnchor, "exposes");
  // a doc with no headings at all anchors to "" and line 1.
  const bare = [{ tag: "P", text: "just a paragraph" }];
  const anchor = computeAnchor(bare, -1, "paragraph");
  assert.equal(anchor.headingAnchor, "");
  assert.equal(anchor.startLine, 1);
});

// ── The mark-serializes-to-nothing contract (AC5 second half) ─────────────────────────────────────────
// A body where a span carries the `comment` mark must serialize to the SAME markdown as the un-marked
// body — the comment lives in the sidecar, never in the prose (ADR-004 / task 14 strips a `comment` mark).
test("the comment mark serializes to nothing — a commented span round-trips unchanged", () => {
  const plain: ProseMirrorDoc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "The lifecycle event stream is append-only." }],
      },
    ],
  };
  // The same paragraph, but "lifecycle event stream" is split out and carries a `comment` mark.
  const commented: ProseMirrorDoc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "The " },
          { type: "text", text: "lifecycle event stream", marks: [{ type: "comment", attrs: { id: "c1" } }] },
          { type: "text", text: " is append-only." },
        ],
      },
    ],
  };
  assert.equal(
    tiptapToMd(commented),
    tiptapToMd(plain),
    "a commented body must serialize identically to the un-commented body",
  );
});
