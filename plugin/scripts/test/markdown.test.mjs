// Tests for lib/process/markdown.mjs — the pure parsing half of the process kit.
// Run: node --test plugin/scripts/test/markdown.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { ownedFiles } from "../lib/lane/brief.mjs";
import { coveredBy } from "../lib/lane/exec/notes.mjs";
import {
  boldLeads,
  cellValue,
  filenameId,
  frontmatter,
  headings,
  maskFences,
  plain,
  section,
  tableIn,
  tables,
  unfenced,
} from "../lib/process/markdown.mjs";
import { bulletOf } from "../lib/process/spec/models.mjs";
import { stepsOf } from "../lib/process/steps.mjs";

const doc = [
  "# Board", //                                   1
  "", //                                          2
  "## Tasks", //                                  3
  "| Task | Note |", //                          4
  "| --- | :---: |", //                          5
  "| **T1** | uses `a.mjs` |", //               6
  "| T2 | one \\| two |", //                   7
  "| T3 |", //                                   8
  "", //                                          9
  "```md", //                                    10
  "## Not a heading", //                         11
  "| Not | a table |", //                       12
  "| --- | --- |", //                          13
  "```", //                                      14
  "### Detail", //                               15
  "## Handoff", //                               16
  "- **T1** (abc1234): landed.", //              17
  "- **T2/T3** (bcd2345, cde3456): both landed.", // 18
  "- **T4 merged** (def4567, + a fix): merged.", //   19
  "* **T5** (local config): no commit.", //      20
  "## After", //                                 21
  "- **T9** (eee5678): outside the section.", // 22
].join("\n");

test("headings skip fenced code and keep their level and line", () => {
  assert.deepEqual(
    headings(doc).map((h) => [h.level, h.text, h.line]),
    [
      [1, "Board", 1],
      [2, "Tasks", 3],
      [3, "Detail", 15],
      [2, "Handoff", 16],
      [2, "After", 21],
    ],
  );
});

// A fence closes only at a line of its own mark, at least as long: a ``` line inside a ~~~ fence, or
// inside a ```` fence, is code (process review P1-2: the ``` closed the ~~~ and `## Fake` read as a heading).
const NESTED = [
  "# Tasks", //                                  1
  "~~~md", //                                    2
  "```", //                                      3
  "## Fake", //                                  4
  "| A | B |", //                                5
  "| --- | --- |", //                            6
  "~~~", //                                      7
  "## Real", //                                  8
  "````", //                                     9
  "```", //                                      10
  "## Also fake", //                             11
  "```", //                                      12
  "````", //                                     13
  "| C | D |", //                                14
  "| --- | --- |", //                            15
  "| 1 | 2 |", //                                16
].join("\n");

test("headings: a ``` line inside a ~~~ or a longer ``` fence neither closes it nor opens one", () => {
  assert.deepEqual(
    headings(NESTED).map((h) => [h.text, h.line]),
    [
      ["Tasks", 1],
      ["Real", 8],
    ],
  );
  assert.equal(section(NESTED, "## Real")?.line, 8);
});

test("tables: a table inside a ~~~ fence that holds a ``` line is code, the one after it is read", () => {
  assert.deepEqual(
    tables(NESTED).map((t) => [t.heading, t.line, t.rows.length]),
    [["Real", 14, 1]],
  );
});

test("maskFences blanks each fence, its lines and line ends kept; an unclosed fence runs to the end", () => {
  const text = "a\r\n~~~\r\n```\r\nb\r\n~~~\r\nc\n```js\nd";
  assert.equal(maskFences(text), "a\r\n   \r\n   \r\n \r\n   \r\nc\n     \n ");
  assert.equal(
    maskFences("```a`b\n## H\n"),
    "```a`b\n## H\n",
    "a backtick in the info string opens none",
  );
  assert.equal(
    maskFences("    ```\n## H\n    ```\n## I\n"),
    "       \n    \n       \n## I\n",
    "a fence indented in a list item, at any depth, is a fence",
  );
});

test("unfenced drops each fence's lines, fence lines included, and keeps the rest as they were", () => {
  assert.equal(unfenced("a\n~~~\n```\n\nb\n~~~\n\nc\n````\n```\n````\nd"), "a\n\nc\nd");
  assert.equal(unfenced("a\r\n```\r\nb\r\n```\r\nc"), "a\r\nc", "a CRLF fence closes");
});

// A fence in a nested list item sits 4 or more columns in (its indent counts from the item's content, as
// in the board's own contracts): every reader of the fence rule reads it as code (R1f-1 r3 N1).
test("models: a Model bullet in a fence nested in a list item is an example, not the contract's model", () => {
  const block = [
    "- **Owns:** `a.mjs`",
    "- **Exposes:**",
    "  - an example contract:",
    "    ```",
    "    - **Model:** opus",
    "    ```",
  ].join("\n");
  assert.equal(bulletOf(block, "model"), null);
});

test("brief: an Owns line in a fence nested in a list item owns nothing", () => {
  const block = [
    "- **Notes:**",
    "  - the shape:",
    "    ```",
    "    **Owns:** `secret/x.mjs`",
    "    ```",
  ].join("\n");
  assert.deepEqual(ownedFiles(block), []);
});

test("steps: a fence nested in a step's list item adds nothing to the step", () => {
  const block = [
    "**Steps:**",
    "1. Build the reader",
    "2. Wire it:",
    "   - like this:",
    "     ```",
    "     **Acceptance:** not a label",
    "     ```",
    "3. Ship it",
  ].join("\n");
  assert.deepEqual(
    stepsOf(block).steps.map((s) => s.text),
    ["Build the reader", "Wire it: - like this:", "Ship it"],
  );
});

test("notes: a recheck line the verifier only quoted in a nested fence covers no label", () => {
  const report = [
    "- N1: the fix is in, the example the builder quoted:",
    "  - verbatim:",
    "    ```",
    "    N2: PASS",
    "    ```",
  ].join("\n");
  assert.equal(coveredBy(report, ["N2"]), false);
});

test("a section runs to the next heading of the same or a higher level", () => {
  assert.equal(section(doc, "Tasks").end, 15, "### Detail is inside ## Tasks");
  assert.equal(section(doc, "Handoff").end, 20);
  assert.equal(section(doc, "Missing"), null);
});

test("a heading given with # marks matches its level, and a text of # is not a mark", () => {
  const text = ["## 5", "a", "### #5", "b", "### 5", "c"].join("\n");
  assert.equal(section(text, "## 5")?.line, 1);
  assert.equal(section(text, "### #5")?.line, 3);
  assert.equal(section(text, "### 5")?.line, 5);
  assert.equal(section(text, "#### 5"), null);
  assert.equal(section("### #5\n", "## 5"), null, "## 5 is not ### #5");
  assert.equal(section("### 5\n", "## 5"), null, "## 5 is not ### 5");
  assert.equal(section("### 5\n", "5")?.line, 1, "no marks: text only");
});

test("a heading may be given with its # marks and loose spaces", () => {
  assert.equal(section(doc, "## Handoff")?.line, 16);
  assert.equal(section(doc, "##Tasks")?.line, 3);
  assert.equal(section("#  Task   contracts  #\n", "# Task contracts")?.line, 1);
  assert.equal(section(doc, "Handoff")?.line, 16, "without marks, any level matches");
  assert.equal(section(doc, "### Handoff"), null, "with marks, the level must match");
});

test("tables map header names to raw cells, with escaped pipes and short rows", () => {
  const [table] = tables(doc);
  assert.equal(tables(doc).length, 1, "the fenced table is not a table");
  assert.equal(table.heading, "Tasks");
  assert.deepEqual(table.header, ["Task", "Note"]);
  assert.deepEqual(
    table.rows.map((r) => [r.line, r.cells]),
    [
      [6, { Task: "**T1**", Note: "uses `a.mjs`" }],
      [7, { Task: "T2", Note: "one | two" }],
      [8, { Task: "T3", Note: "" }],
    ],
  );
  assert.equal(tableIn(doc, section(doc, "Handoff")), null);
});

test("plain strips bold and backticks", () => {
  assert.equal(plain(" **T1** uses `a.mjs` "), "T1 uses a.mjs");
});

test("bold leads yield every id they name, their commits and the whole line", () => {
  const leads = boldLeads(doc, section(doc, "Handoff"));
  assert.deepEqual(
    leads.map((l) => [l.lead, l.ids, l.commits, l.line]),
    [
      ["T1", ["T1"], ["abc1234"], 17],
      ["T2/T3", ["T2", "T3"], ["bcd2345", "cde3456"], 18],
      ["T4 merged", ["T4", "merged"], ["def4567"], 19],
      ["T5", ["T5"], [], 20],
    ],
  );
  assert.equal(leads[0].text, "- **T1** (abc1234): landed.");
  assert.ok(!leads.some((l) => l.ids.includes("T9")), "a lead past the section is not read");
});

test("frontmatter reads flat keys and inline lists, with each key's line", () => {
  const fm = frontmatter('---\nid: E1\ntitle: "First steps"\ntags: [a, "b"]\n---\n# Body\n');
  assert.deepEqual(fm.data, { id: "E1", title: "First steps", tags: ["a", "b"] });
  assert.deepEqual(fm.lines, { id: 2, title: 3, tags: 4 });
  assert.equal(frontmatter("# No frontmatter\n"), null);
});

test("cellValue reads each field type", () => {
  assert.deepEqual(cellValue("T1, T2 ,, `T3`", { type: "list" }), ["T1", "T2", "T3"]);
  assert.deepEqual(cellValue(["T1", "**T2**"], { type: "list" }), ["T1", "T2"]);
  assert.deepEqual(cellValue("abc1234 0f9e8d7c", { type: "commits" }), ["abc1234", "0f9e8d7c"]);
  assert.deepEqual(cellValue("2026-01-05; 12 files", { type: "commits" }), []);
  assert.equal(cellValue("⚑", { type: "flag", mark: "⚑" }), true);
  assert.equal(cellValue("", { type: "flag", mark: "⚑" }), false);
  assert.equal(cellValue("x", { type: "flag" }), true);
  assert.equal(cellValue("[The loop](sprints/A1.md)", { type: "link" }), "The loop");
  assert.equal(cellValue("No link", { type: "link" }), "No link");
  assert.equal(cellValue("", { type: "link" }), null);
  assert.equal(cellValue("2026-01-12 (late)", { type: "date" }), "2026-01-12");
  assert.equal(cellValue("soon", { type: "date" }), null);
  assert.equal(cellValue("pass with notes", { case: "upper" }), "PASS WITH NOTES");
});

test("cellValue: evidence is the SHAs, then the rest as one note token", () => {
  const evidence = { type: "evidence" };
  assert.deepEqual(cellValue("abc1234", evidence), ["abc1234"]);
  assert.deepEqual(cellValue("abc1234, bcd2345; verifier PASS", evidence), [
    "abc1234",
    "bcd2345",
    "verifier PASS",
  ]);
  assert.deepEqual(cellValue("moved 2026-02-01; links updated", evidence), [
    "moved 2026-02-01; links updated",
  ]);
  assert.deepEqual(cellValue("", evidence), []);
});

test("cellValue: match takes group 1, else the whole match, else null", () => {
  assert.equal(cellValue("M1 · First light", { match: "^(\\S+)" }), "M1");
  assert.equal(cellValue("M1 · First light", { match: "·\\s*(.+)$" }), "First light");
  assert.equal(cellValue("M1 · First light", { match: "\\d" }), "1");
  assert.equal(cellValue("plain", { match: "·(.+)" }), null);
  assert.equal(cellValue("plain", { match: "(" }), null, "an invalid regex reads as no match");
});

test("filenameId turns a {id} pattern into a basename regex", () => {
  assert.equal(filenameId("{id}.md").exec("S-1.md")[1], "S-1");
  assert.equal(filenameId("ADR-{id}-*.md").exec("ADR-7-cache.md")[1], "7");
  assert.equal(filenameId("{id}.md").exec("S-1.txt"), null);
});
