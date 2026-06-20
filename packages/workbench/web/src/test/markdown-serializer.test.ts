// The golden round-trip corpus (ADR-004) — the tripwire against silent artifact corruption.
//
// The core acceptance: `tiptapToMd(mdToTiptap(x)) === normalize(x)` for every real `.agentry/` artifact
// fixture (idempotent up to normalization). Plus two guards proving the tripwire actually bites:
//   - `normalize` is byte-stable on a no-op (same input twice → same output) — the ADR-006 link.
//   - a deliberately-lossy mapping FAILS the golden assertion — proof the guard isn't vacuous.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { mdToTiptap, normalize, tiptapToMd } from "../routes/work/live/doc/markdown-serializer.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

// Real `.agentry/` artifact bodies (frontmatter already stripped — only the body round-trips, per ADR-004):
// a spec, a plan, an ADR with Context/Decision/Alternatives/Consequences, a task with a deps list + a code fence.
const CORPUS = ["spec", "plan", "adr", "task"] as const;

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.md`), "utf8");
}

// ── The core tripwire: round-trip identity up to normalization, for every corpus artifact ────────────────
for (const name of CORPUS) {
  test(`round-trip is identity up to normalization: ${name}`, () => {
    const body = fixture(name);
    const roundTripped = tiptapToMd(mdToTiptap(body));
    assert.equal(roundTripped, normalize(body), `${name}: round-trip must equal normalize(body)`);
  });

  test(`normalize is idempotent (byte-stable on a no-op): ${name}`, () => {
    const body = fixture(name);
    const once = normalize(body);
    const twice = normalize(once);
    assert.equal(twice, once, `${name}: normalize(normalize(x)) must equal normalize(x)`);
    // And re-parsing the canonical form leaves it byte-identical — a no-op editor session is stable.
    assert.equal(tiptapToMd(mdToTiptap(once)), once, `${name}: a canonical body survives the round-trip`);
  });
}

// ── normalize is byte-stable: the same input twice yields the same output (the AC6 / ADR-006 link) ───────
test("normalize is byte-stable across two independent calls on the same input", () => {
  const body = fixture("adr");
  assert.equal(normalize(body), normalize(body));
});

// ── The schema constructs are preserved (not just stable — actually round-tripped) ──────────────────────
test("preserves the fixed schema constructs through the round-trip", () => {
  const body = [
    "# Heading",
    "",
    "A paragraph with **bold**, *italic*, `code`, and a [link](https://example.com).",
    "",
    "- bullet one",
    "- bullet two",
    "",
    "1. ordered one",
    "2. ordered two",
    "",
    "> a blockquote",
    "",
    "```ts",
    "const x = 1;",
    "```",
  ].join("\n");
  const out = normalize(body);
  assert.match(out, /^# Heading$/m, "ATX heading kept");
  assert.match(out, /\*\*bold\*\*/, "bold delimiter is **");
  assert.match(out, /\*italic\*/, "italic delimiter is *");
  assert.match(out, /`code`/, "inline code kept");
  assert.match(out, /\[link\]\(https:\/\/example\.com\)/, "link kept");
  assert.match(out, /^- bullet one$/m, "bullet marker normalized to -");
  assert.match(out, /^1\. ordered one$/m, "ordered list kept");
  assert.match(out, /^> a blockquote$/m, "blockquote kept");
  assert.match(out, /```ts\nconst x = 1;\n```/, "fenced code block with language kept");
});

// ── Fidelity (NOT self-referential): round-trip output is checked against a known-correct canonical literal,
// so a corruption that is merely *stable* (passes the idempotence check) still fails here. This catches the
// emphasis-split class of bug — a `*write contract*` span arriving as two italic text nodes around a soft
// break, which a naive per-node emitter corrupts to `*write** **contract*`. ──────────────────────────────
test("a span split across a soft break round-trips without corrupting its delimiters", () => {
  // Two italic text nodes either side of a soft break — exactly what markdown-it emits for `*a b*` wrapped.
  assert.equal(normalize("the *write\ncontract* matters"), "the *write contract* matters");
  assert.equal(normalize("a **bold\nspan** b"), "a **bold span** b");
  assert.equal(normalize("a [link\ntext](http://x) b"), "a [link text](http://x) b");
});

test("does not merge two adjacent links with different hrefs", () => {
  assert.equal(normalize("[a](http://1)[b](http://2)"), "[a](http://1)[b](http://2)");
});

// ── The comment mark serializes to NOTHING (ADR-004: UI-only, never written to markdown) ────────────────
test("the comment mark serializes to nothing (stripped from markdown output)", () => {
  // A Tiptap doc with a `comment`-marked span — task 18's UI-only annotation. tiptapToMd must drop the
  // mark and emit only the underlying text, exactly as if the comment were never there.
  const doc = {
    type: "doc" as const,
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "before " },
          { type: "text", text: "annotated", marks: [{ type: "comment", attrs: { id: "c1" } }] },
          { type: "text", text: " after" },
        ],
      },
    ],
  };
  assert.equal(tiptapToMd(doc), "before annotated after", "comment mark leaves no markdown trace");
});

// ── The guard bites: a deliberately-lossy serializer FAILS the golden assertion ──────────────────────────
// This proves the tripwire isn't vacuous. We re-implement a *lossy* tiptapToMd (emits __bold__ instead of
// **bold**, the classic corruption ADR-004 names) and assert the golden equality it would replace does NOT
// hold — i.e. a real serializer regression would turn a golden test red.
test("a deliberately-lossy mapping fails the golden assertion (the guard bites)", () => {
  const lossyTiptapToMd = (doc: ReturnType<typeof mdToTiptap>): string =>
    // Round-trip honestly, then corrupt the bold delimiter — the exact silent-corruption ADR-004 guards.
    tiptapToMd(doc).replace(/\*\*([^*]+)\*\*/g, "__$1__");

  const body = fixture("spec"); // the spec fixture contains **bold** spans
  const honest = tiptapToMd(mdToTiptap(body));
  const corrupted = lossyTiptapToMd(mdToTiptap(body));

  assert.notEqual(corrupted, normalize(body), "the lossy mapping must NOT equal normalize(body)");
  assert.notEqual(corrupted, honest, "the lossy mapping must differ from the honest round-trip");
});
