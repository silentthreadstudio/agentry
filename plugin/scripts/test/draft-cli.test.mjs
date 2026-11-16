// Tests for `board draft apply` of a decision with no drafts.decision in the workflow file (the map is derived
// from the decision kind), the draft's `why`, an answer edited at apply, an empty why, a rule like one already
// written, and `add --fields` from a file or stdin (cli/draft.mjs).
// Run: node --test plugin/scripts/test/draft-cli.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { BOARD, SPEC, board, boardRepo, read } from "./drift-repo.mjs";

const cleanups = [];
after(() => {
  for (const c of cleanups) c();
});

const DECISIONS = "plan/DECISIONS.md";
const TABLE =
  "# Decisions\n\n## Decisions\n\n| # | Decision | Why | Rejected |\n| --- | --- | --- | --- |\n| D1 | First | Because | none |\n";
const DECISION_KIND = {
  label: "Decision",
  at: { table: "DECISIONS.md", heading: "Decisions" },
  id: { column: "#" },
  fields: {
    decision: { column: "Decision" },
    why: { column: "Why" },
    rejected: { column: "Rejected" },
  },
  create: {
    ask: ["decision", "why"],
    id: "D{n}",
    rows: [
      {
        in: "self",
        at: "end",
        cells: { "#": "{id}", Decision: "{decision}", Why: "{why}", Rejected: "{rejected}" },
      },
    ],
  },
};
const { drafts: _drafts, ...NO_DRAFTS } = SPEC;
const withKinds = (kinds, extra = {}) => ({
  ...NO_DRAFTS,
  kinds: { ...NO_DRAFTS.kinds, ...kinds },
  ...extra,
});

/** A scratch repo whose decision table is `decision | why | rejected` and whose workflow file has no `drafts`. */
function fresh(spec = withKinds({ decision: DECISION_KIND })) {
  const repo = boardRepo({ spec });
  cleanups.push(repo.cleanup);
  writeFileSync(join(repo.root, DECISIONS), TABLE);
  return repo;
}
const add = (root, draft) => board(root, "draft", "add", "--fields", JSON.stringify(draft));
const DRAFT = {
  kind: "decision",
  answer: "Keep the board in markdown",
  why: "It diffs well",
  question: "Where?",
  unpicked: ["a database", "a wiki"],
};
const NOTE =
  "drafts.decision derived from the decision kind (set it in workflow.json to change it)";
const filePath = (root) => join(root, ".agentry", "run", "process", "drafts.jsonl");
const stored = (root) =>
  readFileSync(filePath(root), "utf8")
    .trimEnd()
    .split("\n")
    .map((l) => JSON.parse(l));

test("with no drafts.decision, apply derives the map from the decision kind and writes the next id", () => {
  const { root } = fresh();
  add(root, DRAFT);
  const out = board(root, "draft", "apply", "1", "--apply");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^applied draft 1: added decision D2\n/);
  assert.ok(out.stdout.includes(NOTE), out.stdout);
  assert.match(
    read(root, DECISIONS),
    /\| D2 +\| Keep the board in markdown +\| It diffs well +\| a database, a wiki +\|/,
  );
  assert.equal(board(root, "check").status, 0);
});

test("the preview of a derived map says so and writes nothing", () => {
  const { root } = fresh();
  add(root, DRAFT);
  const out = board(root, "draft", "apply", "1");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.ok(out.stdout.includes(NOTE));
  assert.equal(read(root, DECISIONS), TABLE);
});

test("a draft's why fills {why}; with none the question does", () => {
  const { root } = fresh();
  add(root, { kind: "decision", answer: "No wiki", question: "Where do notes live?" });
  assert.equal(board(root, "draft", "apply", "1", "--apply").status, 0);
  assert.match(read(root, DECISIONS), /\| D2 +\| No wiki +\| Where do notes live\? +\|/);
});

test("the decision kind is the only kind with a decision field when none is named decision", () => {
  const { decision: _d, ...others } = NO_DRAFTS.kinds;
  const { root } = fresh({ ...NO_DRAFTS, kinds: { ...others, log: DECISION_KIND } });
  add(root, DRAFT);
  const out = board(root, "draft", "apply", "1", "--apply");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.ok(out.stdout.includes("derived from the log kind"), out.stdout);
});

test("no decision kind and no drafts.decision: exit 2 naming the fix, nothing written", () => {
  const { decision: _d, ...kinds } = NO_DRAFTS.kinds;
  const { root } = fresh({ ...NO_DRAFTS, kinds });
  add(root, DRAFT);
  const out = board(root, "draft", "apply", "1", "--apply");
  assert.equal(out.status, 2);
  assert.ok(
    out.stderr.includes(
      "✗ board draft: no decision kind and no drafts.decision → add drafts.decision to .agentry/workflow.json (format.md § lifecycle and drafts)",
    ),
    out.stderr,
  );
  assert.equal(stored(root)[0].state, "pending");
});

test("two kinds with a decision field and none named decision derive nothing", () => {
  const a = { ...DECISION_KIND };
  const b = { ...DECISION_KIND, at: { table: "OTHER.md", heading: "Other" } };
  const { decision: _d, ...kinds } = NO_DRAFTS.kinds;
  const { root } = fresh({ ...NO_DRAFTS, kinds: { ...kinds, a, b } });
  add(root, DRAFT);
  const out = board(root, "draft", "apply", "1", "--apply");
  assert.equal(out.status, 2);
  assert.match(out.stderr, /no decision kind and no drafts\.decision/);
});

test("an explicit drafts.decision always wins over the derived map", () => {
  const spec = withKinds(
    { decision: DECISION_KIND },
    { drafts: { decision: { kind: "decision", map: { decision: "{answer}", rejected: "mine" } } } },
  );
  const { root } = fresh(spec);
  add(root, DRAFT);
  const out = board(root, "draft", "apply", "1", "--apply");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.ok(!out.stdout.includes("derived"), out.stdout);
  const row = read(root, DECISIONS)
    .split("\n")
    .find((l) => l.startsWith("| D2"));
  assert.match(
    row,
    /\| Keep the board in markdown +\| +\| mine +\|/,
    "why is not filled: the map has none",
  );
});

test("a map naming a field the kind lacks is refused and nothing is written", () => {
  const spec = withKinds(
    { decision: DECISION_KIND },
    { drafts: { decision: { kind: "decision", map: { decision: "{answer}", nope: "{why}" } } } },
  );
  const { root } = fresh(spec);
  add(root, DRAFT);
  const out = board(root, "draft", "apply", "1", "--apply");
  assert.equal(out.status, 2);
  assert.match(out.stderr, /names "nope", a field decision lacks/);
  assert.equal(read(root, DECISIONS), TABLE);
  assert.equal(stored(root)[0].state, "pending");
});

test("apply --answer and --why write the edited text, logged as edited on the draft", () => {
  const { root } = fresh();
  add(root, DRAFT);
  const preview = board(
    root,
    "draft",
    "apply",
    "1",
    "--answer",
    "Keep it in git",
    "--why",
    "Review",
  );
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.match(preview.stdout, /\+ \| D2 +\| Keep it in git +\| Review +\|/);
  assert.equal(read(root, DECISIONS), TABLE, "the preview writes nothing");
  assert.equal(stored(root)[0].state, "pending");
  const out = board(
    root,
    "draft",
    "apply",
    "1",
    "--answer",
    "Keep it in git",
    "--why",
    "Review",
    "--apply",
  );
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(read(root, DECISIONS), /\| D2 +\| Keep it in git +\| Review +\|/);
  const [line] = stored(root);
  assert.equal(line.state, "applied");
  assert.equal(line.answer, "Keep it in git");
  assert.deepEqual(line.edited, { answer: "Keep the board in markdown", why: "It diffs well" });
  assert.equal(stored(root).length, 1, "one line: no drop and re-add");
});

test("an answer that is not edited leaves no edited mark", () => {
  const { root } = fresh();
  add(root, DRAFT);
  assert.equal(board(root, "draft", "apply", "1", "--apply").status, 0);
  assert.equal(stored(root)[0].edited, undefined);
});

test('--answer "" is refused with exit 2 and nothing is written', () => {
  const { root } = fresh();
  add(root, DRAFT);
  const before = readFileSync(filePath(root), "utf8");
  for (const args of [["--answer", ""], ["--answer", "  "], ["--why", ""], ["--answer"]]) {
    const out = board(root, "draft", "apply", "1", ...args, "--apply");
    assert.equal(out.status, 2, args.join(" "));
  }
  assert.equal(read(root, DECISIONS), TABLE);
  assert.equal(readFileSync(filePath(root), "utf8"), before);
});

test("--answer goes with apply only", () => {
  const { root } = fresh();
  add(root, DRAFT);
  assert.equal(board(root, "draft", "drop", "1", "--answer", "x").status, 2);
  assert.equal(stored(root)[0].state, "pending");
});

test("a rule draft is unchanged: it appends under conductor.rules; --answer edits it, --why is refused", () => {
  const { root } = fresh();
  add(root, { kind: "rule", answer: "Recall first.", why: "ignored" });
  add(root, { kind: "rule", answer: "Draft text." });
  assert.equal(board(root, "draft", "apply", "1", "--why", "x", "--apply").status, 2);
  assert.equal(board(root, "draft", "apply", "1", "--apply").status, 0);
  assert.equal(board(root, "draft", "apply", "2", "--answer", "Edited text.", "--apply").status, 0);
  assert.match(
    read(root, "CONDUCTOR.md"),
    /## Standing rules\n\n- Existing rule\.\n- Recall first\.\n- Edited text\.\n/,
  );
});

test("applying the same draft twice writes once", () => {
  const { root } = fresh();
  add(root, DRAFT);
  assert.equal(board(root, "draft", "apply", "1", "--apply").status, 0);
  const once = read(root, DECISIONS);
  assert.equal(board(root, "draft", "apply", "1", "--answer", "again", "--apply").status, 2);
  assert.equal(read(root, DECISIONS), once);
  assert.equal(once.split("\n").filter((l) => l.startsWith("| D")).length, 2);
});

const BARE = { kind: "decision", answer: "Keep the board in markdown", unpicked: ["a wiki"] };

test("a decision whose why fills empty is flagged in the preview and refused on --apply without --why", () => {
  const { root } = fresh();
  add(root, BARE);
  const preview = board(root, "draft", "apply", "1");
  assert.equal(preview.status, 0);
  assert.match(preview.stdout, /\n! why is empty\n/);
  const refused = board(root, "draft", "apply", "1", "--apply");
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /^✗ board draft: why is empty → board draft apply 1 --why/);
  assert.equal(read(root, DECISIONS), TABLE);
  const ok = board(root, "draft", "apply", "1", "--why", "It diffs well", "--apply");
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(read(root, DECISIONS), /\| D2 +\| Keep the board in markdown +\| It diffs well +\|/);
});

test("--json carries the warnings of a preview", () => {
  const { root } = fresh();
  add(root, BARE);
  const out = JSON.parse(board(root, "draft", "apply", "1", "--json").stdout);
  assert.deepEqual(out.warnings, ["! why is empty"]);
});

test("an empty rejected column is a note only: the preview says it and apply writes", () => {
  const { root } = fresh();
  add(root, { kind: "decision", answer: "No wiki", why: "Too heavy" });
  const preview = board(root, "draft", "apply", "1");
  assert.match(preview.stdout, /\n! rejected is empty\n/);
  assert.doesNotMatch(preview.stdout, /why is empty/);
  const out = board(root, "draft", "apply", "1", "--apply");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /\n! rejected is empty\n$/);
});

test("a decision with a why and a rejected column carries no warning", () => {
  const { root } = fresh();
  add(root, DRAFT);
  assert.doesNotMatch(board(root, "draft", "apply", "1").stdout, /^!/m);
});

test("a rule like one already in its section is flagged, refused on --apply and written with --force", () => {
  const { root } = fresh();
  add(root, { kind: "rule", answer: "**EXISTING**  rule. (2026-11-16)" });
  const preview = board(root, "draft", "apply", "1");
  assert.equal(preview.status, 0);
  assert.match(preview.stdout, /\n! similar rule already at CONDUCTOR\.md:5\n/);
  const refused = board(root, "draft", "apply", "1", "--apply");
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /similar rule already at CONDUCTOR\.md:5 → board draft apply 1 --force/);
  assert.doesNotMatch(read(root, "CONDUCTOR.md"), /2026/);
  const forced = board(root, "draft", "apply", "1", "--force", "--apply");
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  assert.match(read(root, "CONDUCTOR.md"), /- Existing rule\.\n- \*\*EXISTING\*\* rule\. \(2026-11-16\)\n/);
});

test("a rule that is not like any line of its section is written without a flag", () => {
  const { root } = fresh();
  add(root, { kind: "rule", answer: "Always run the gate before a merge." });
  const out = board(root, "draft", "apply", "1", "--apply");
  assert.equal(out.status, 0);
  assert.doesNotMatch(out.stdout, /!/);
});

test("--force goes with apply only", () => {
  const { root } = fresh();
  assert.equal(board(root, "draft", "list", "--force").status, 2);
});

test("draft add --fields @<path> reads the draft from a file", () => {
  const { root } = fresh();
  writeFileSync(join(root, "d.json"), JSON.stringify(DRAFT));
  const out = board(root, "draft", "add", "--fields", `@${join(root, "d.json")}`);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(stored(root)[0].answer, DRAFT.answer);
});

test("draft add --fields - reads the draft from stdin", () => {
  const { root } = fresh();
  const out = spawnSync("node", [BOARD, "draft", "add", "--fields", "-", "--root", root], {
    input: JSON.stringify(DRAFT),
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(stored(root)[0].why, "It diffs well");
});

test("draft add --fields @<missing file> is refused naming it, nothing stored", () => {
  const { root } = fresh();
  const out = board(root, "draft", "add", "--fields", `@${join(root, "nope.json")}`);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /cannot read --fields from .*nope\.json \(ENOENT\)/);
});
