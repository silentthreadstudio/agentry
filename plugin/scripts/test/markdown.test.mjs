// Tests for lib/process/markdown.mjs — the pure parsing half of the process kit.
// Run: node --test plugin/scripts/test/markdown.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boldLeads,
  cellValue,
  filenameId,
  frontmatter,
  headings,
  plain,
  section,
  tableIn,
  tables,
} from "../lib/process/markdown.mjs";

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

test("a section runs to the next heading of the same or a higher level", () => {
  assert.equal(section(doc, "Tasks").end, 15, "### Detail is inside ## Tasks");
  assert.equal(section(doc, "Handoff").end, 20);
  assert.equal(section(doc, "Missing"), null);
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
  assert.equal(cellValue("[The loop](sprints/A1.md)", { type: "link" }), "sprints/A1.md");
  assert.equal(cellValue("No link", { type: "link" }), null);
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
