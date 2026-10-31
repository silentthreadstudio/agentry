// Tests for lib/lane/report.mjs — pure readers of a dispatched agent's report, on bare reports and on the
// opencode V2 / V1 wrappers, with the marker on line 1 and on line 2.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  builderStatus,
  findMarker,
  summaryOf,
  unwrap,
  usedMemories,
  verdictOf,
} from "../lib/lane/report.mjs";

const MARKER = "agentry-task: T-7 role=verify round=2";
const BODY = "DONE: built the thing\n\nused_memories: [p:01ABC, f:xyz]\n";
const VERDICT = "Checked all five.\n\nVerdict: PASS WITH NOTES";

// The same report in each shape a host hands back.
const wrap = {
  bare: (t) => t,
  v2: (t) => `<subagent sessionID=ses_1 state="completed">\n${t}\n</subagent>`,
  v1: (t) => `<task id=ses_1 state="completed"><task_result>\n${t}\n</task_result></task>`,
  v1inline: (t) => `<task id=ses_1 state="completed"><task_result>${t}</task_result></task>`,
};

for (const [shape, w] of Object.entries(wrap)) {
  test(`${shape}: status, memories, summary and verdict read the same`, () => {
    assert.equal(builderStatus(w(BODY)), "DONE");
    assert.deepEqual(usedMemories(w(BODY)), ["p:01ABC", "f:xyz"]);
    assert.equal(summaryOf(w(BODY)), "built the thing");
    assert.equal(verdictOf(w(VERDICT)), "PASS WITH NOTES");
  });

  test(`${shape}: the marker is found on line 1 and on line 2`, () => {
    const want = { id: "T-7", role: "verify", round: 2 };
    assert.deepEqual(findMarker(w(`${MARKER}\nbody`)), want);
    assert.deepEqual(
      findMarker(w(`You are a subagent spawned by another session.\n${MARKER}\nbody`)),
      want,
    );
  });
}

test("unwrap drops every wrapper tag and keeps the text", () => {
  const out = unwrap('<subagent id=1 state="completed">\n<text>\nhello\n</text>\n</subagent>');
  assert.equal(out.replace(/\s+/g, " ").trim(), "hello");
  assert.equal(unwrap(undefined), "");
});

test("findMarker: absent, beyond the window, or without a role", () => {
  assert.equal(findMarker("just a report"), null);
  assert.equal(findMarker("a\nb\nc\nd\ne\nagentry-task: T-1 role=build"), null);
  assert.deepEqual(findMarker("a\nb\nc\nd\nagentry-task: T-1 role=build", { within: 5 }), {
    id: "T-1",
    role: "build",
  });
  assert.deepEqual(findMarker("agentry-task: R1b-2"), { id: "R1b-2", role: null });
  assert.equal(findMarker("a\nb\nagentry-task: T-1 role=build", { within: 2 }), null);
});

test("builderStatus: all four tokens, DONE is not read out of DONE_WITH_CONCERNS", () => {
  assert.equal(builderStatus("DONE_WITH_CONCERNS\n- a smell"), "DONE_WITH_CONCERNS");
  assert.equal(builderStatus("**NEEDS_CONTEXT** need file x"), "NEEDS_CONTEXT");
  assert.equal(builderStatus("Status: BLOCKED"), "BLOCKED");
  assert.equal(builderStatus("# Report\n\nDONE"), "DONE");
});

test("builderStatus: null when absent, past the first 5 lines, or only a prefix of a word", () => {
  assert.equal(builderStatus("I finished the work."), null);
  assert.equal(builderStatus("a\nb\nc\nd\ne\nDONE"), null);
  assert.equal(builderStatus("DONENESS is a word"), null);
  assert.equal(builderStatus(""), null);
});

test("verdictOf: must be the last non-empty line, exact", () => {
  assert.equal(verdictOf("notes\nVerdict: PASS\n\n\n"), "PASS");
  assert.equal(verdictOf("Verdict: FAIL"), "FAIL");
  assert.equal(verdictOf("**Verdict: PASS**"), "PASS");
});

test("verdictOf refuses a verdict that is not last, has prose after it, or is misspelled", () => {
  assert.equal(verdictOf("Verdict: PASS\nbut one more thing"), null);
  assert.equal(verdictOf("Verdict: PASS, mostly"), null);
  assert.equal(verdictOf("Verdict: pass"), null);
  assert.equal(verdictOf("Verdict: PASS WITH"), null);
  assert.equal(verdictOf("PASS"), null);
  assert.equal(verdictOf(""), null);
});

test("verdictOf sees through a wrapper closer that follows the verdict", () => {
  assert.equal(verdictOf("<task_result>\nVerdict: FAIL\n</task_result>\n</task>"), "FAIL");
});

test("usedMemories: reads only an explicit used_memories line, never words from prose", () => {
  assert.deepEqual(usedMemories("I used_memories: p:01X while building"), []); // mid-sentence
  assert.deepEqual(usedMemories("used_memories: none needed, I used the wiki"), []);
  assert.deepEqual(usedMemories("used_memories: p:01X (the retry gotcha), g:9Z because of it"), [
    "p:01X",
    "g:9Z",
  ]);
  assert.deepEqual(usedMemories("used_memories:\n- g:01A why it helped\n- none\nnext: p:02B"), [
    "g:01A",
  ]);
  assert.deepEqual(usedMemories("used_memories: a1, b2"), []); // not memory ids
});

test("usedMemories: inline list, bullets, dedupe, and the none forms", () => {
  assert.deepEqual(usedMemories("used_memories: p:a1, g:b2, p:a1"), ["p:a1", "g:b2"]);
  assert.deepEqual(usedMemories("used_memories:\n- p:01X\n- p:02Y\nnext: thing"), [
    "p:01X",
    "p:02Y",
  ]);
  assert.deepEqual(usedMemories('**used_memories**: ["p:m1", "g:m2"]'), ["p:m1", "g:m2"]);
  for (const none of [
    "used_memories: []",
    "used_memories: none",
    "used_memories: (none)",
    "no mention",
  ])
    assert.deepEqual(usedMemories(none), [], none);
});

test("summaryOf: skips the marker, headings and verdict; caps at 120 chars", () => {
  assert.equal(
    summaryOf(`${MARKER}\n# Result\nDONE\nShipped the router move.`),
    "Shipped the router move.",
  );
  assert.equal(summaryOf("Verdict: PASS"), "");
  const long = summaryOf(`DONE ${"x".repeat(300)}`);
  assert.equal(long.length, 120);
  assert.ok(long.endsWith("…"));
});
