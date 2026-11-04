// Tests for lib/process/drafts.mjs and `board draft` (cli/draft.mjs): drafts kept outside the repo, numbered
// for good, applied only on request, a decision through next-id and add, a rule under conductor.rules.
// Run: node --test plugin/scripts/test/drafts.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import * as drafts from "../lib/process/drafts.mjs";
import { SPEC, board, boardRepo, builtBranch, read } from "./drift-repo.mjs";

const cleanups = [];
after(() => {
  for (const c of cleanups) c();
});
function fresh(opts) {
  const repo = boardRepo(opts);
  cleanups.push(repo.cleanup);
  return repo;
}
const add = (root, draft) => board(root, "draft", "add", "--fields", JSON.stringify(draft));
const DECISION = { kind: "decision", answer: "Keep the board in markdown", question: "Where?" };

test("problem: a draft needs a known kind and some answer text, and nothing unknown", () => {
  assert.equal(drafts.problem(DECISION), null);
  assert.match(drafts.problem({ ...DECISION, kind: "idea" }), /kind must be one of/);
  assert.match(drafts.problem({ kind: "rule", answer: "  " }), /answer must be some text/);
  assert.match(drafts.problem({ ...DECISION, extra: 1 }), /no "extra"/);
  assert.match(drafts.problem({ ...DECISION, unpicked: [1] }), /unpicked/);
  assert.equal(drafts.problem({ ...DECISION, why: "Because" }), null);
  assert.match(drafts.problem({ ...DECISION, why: 1 }), /why must be text/);
  assert.match(drafts.problem([]), /JSON object/);
});

test("drafts keep their number for good: dropping one never frees it", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentry-drafts-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(drafts.list(dir), []);
  assert.equal(drafts.add(dir, DECISION).n, 1);
  assert.equal(drafts.add(dir, DECISION).n, 2);
  drafts.mark(dir, 2, "dropped");
  assert.equal(drafts.add(dir, DECISION).n, 3);
  assert.deepEqual(
    drafts.pending(dir).map((d) => d.n),
    [1, 3],
  );
  assert.equal(drafts.mark(dir, 9, "applied"), null);
});

test("a torn line in the file is skipped and the rest still read", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentry-drafts-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  drafts.add(dir, DECISION);
  writeFileSync(
    join(dir, ".agentry", "run", "process", "drafts.jsonl"),
    `${JSON.stringify({ n: 1, kind: "rule", answer: "a", state: "pending" })}\n{"n": 2, "ki\n`,
  );
  assert.deepEqual(
    drafts.list(dir).map((d) => d.n),
    [1],
  );
});

test("a torn line's number is never given to a new draft", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentry-drafts-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  drafts.add(dir, DECISION);
  const file = join(dir, ".agentry", "run", "process", "drafts.jsonl");
  writeFileSync(file, `${readFileSync(file, "utf8")}{"n":2,"kind":"rule","ans`);
  assert.equal(drafts.add(dir, DECISION).n, 3, "2 is the torn line's");
  writeFileSync(file, `${readFileSync(file, "utf8")}not json at all\n`);
  assert.equal(drafts.add(dir, DECISION).n, 5, "a line with no number still holds its place");
});

test("add, list and drop keep drafts in the run state and never write the repo", () => {
  const { root } = fresh();
  const board0 = read(root, "plan/DECISIONS.md");
  const out = add(root, DECISION);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^drafted 1: decision, Keep the board in markdown/);
  add(root, { kind: "rule", answer: "Always recall first" });
  const list = board(root, "draft", "list").stdout.trimEnd().split("\n");
  assert.equal(list.length, 2);
  assert.match(list[0], /^ {2}1 {2}decision {2}Keep the board in markdown$/);
  assert.equal(board(root, "draft", "drop", "1").status, 0);
  assert.match(board(root, "draft", "list").stdout, /^ {2}2 {2}rule/);
  assert.equal(read(root, "plan/DECISIONS.md"), board0);
  assert.ok(existsSync(join(root, ".agentry", "run", "process", "drafts.jsonl")));
  assert.equal(board(root, "status").status, 0);
});

test("a bad draft is refused with exit 2 and stores nothing", () => {
  const { root } = fresh();
  assert.equal(add(root, { kind: "idea", answer: "x" }).status, 2);
  assert.equal(board(root, "draft", "add", "--fields", "{nope").status, 2);
  assert.equal(board(root, "draft", "add").status, 2);
  assert.match(board(root, "draft", "list").stdout, /no pending drafts/);
});

test("apply without --apply shows what it would write, writes nothing and keeps the draft", () => {
  const { root } = fresh();
  add(root, DECISION);
  const before = read(root, "plan/DECISIONS.md");
  const out = board(root, "draft", "apply", "1");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^draft 1:\nwould add decision D2\n/);
  assert.match(out.stdout, /\+ \| D2 +\| Keep the board in markdown/);
  assert.match(out.stdout, /\npreview: nothing written; add --apply to write it\n$/);
  assert.equal(read(root, "plan/DECISIONS.md"), before);
  assert.match(board(root, "draft", "list").stdout, /decision/, "still pending");
  const listed = JSON.parse(board(root, "draft", "list", "--json").stdout);
  assert.deepEqual(
    listed.pending.map((d) => [d.n, d.kind]),
    [[1, "decision"]],
  );
  assert.equal(board(root, "draft", "drop", "1", "--apply").status, 2, "--apply is apply's only");
});

test("apply of a decision goes through next-id and add, filling the process file's map", () => {
  const { root } = fresh();
  add(root, DECISION);
  const out = board(root, "draft", "apply", "1", "--apply");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^applied draft 1: added decision D2/);
  assert.match(
    read(root, "plan/DECISIONS.md"),
    /\| D2 +\| Keep the board in markdown +\| Where\? +\|/,
  );
  assert.match(board(root, "draft", "list").stdout, /no pending drafts/);
  assert.equal(board(root, "draft", "apply", "1", "--apply").status, 2, "applied once only");
  assert.equal(board(root, "check").status, 0);
});

test("apply of a decision with no drafts.decision and no decision kind is refused", () => {
  const { drafts: _, ...bare } = SPEC;
  const { decision: __, ...kinds } = bare.kinds;
  const { root } = fresh({ spec: { ...bare, kinds } });
  add(root, DECISION);
  const before = read(root, "plan/DECISIONS.md");
  const out = board(root, "draft", "apply", "1", "--apply");
  assert.equal(out.status, 2);
  assert.match(out.stderr, /no drafts\.decision/);
  assert.equal(read(root, "plan/DECISIONS.md"), before);
  assert.match(board(root, "draft", "list").stdout, /decision/, "the draft stays pending");
});

test("a placeholder the map does not know is refused", () => {
  const spec = { ...SPEC, drafts: { decision: { kind: "decision", map: { decision: "{nope}" } } } };
  const { root } = fresh({ spec });
  add(root, DECISION);
  const out = board(root, "draft", "apply", "1", "--apply");
  assert.equal(out.status, 2);
  assert.match(out.stderr, /unknown placeholder \{nope\}/);
});

test("apply of a rule appends it under conductor.rules in the conductor prompt", () => {
  const { root } = fresh();
  add(root, { kind: "rule", answer: "Recall before any change." });
  const out = board(root, "draft", "apply", "1", "--apply");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(
    read(root, "CONDUCTOR.md"),
    /## Standing rules\n\n- Existing rule\.\n- Recall before any change\.\n/,
  );
});

test("a rule draft with no conductor.rules heading is exit 2 and writes nothing", () => {
  const spec = { ...SPEC, conductor: { prompt: "CONDUCTOR.md" } };
  const { root } = fresh({ spec });
  add(root, { kind: "rule", answer: "Recall before any change." });
  const before = read(root, "CONDUCTOR.md");
  const out = board(root, "draft", "apply", "1", "--apply");
  assert.equal(out.status, 2);
  assert.match(out.stderr, /no conductor\.rules heading/);
  assert.equal(read(root, "CONDUCTOR.md"), before);
});

test("a rule whose heading is not in the prompt is exit 2 and the draft stays pending", () => {
  const spec = { ...SPEC, conductor: { prompt: "CONDUCTOR.md", rules: "No such heading" } };
  const { root } = fresh({ spec });
  add(root, { kind: "rule", answer: "Recall before any change." });
  const out = board(root, "draft", "apply", "1", "--apply");
  assert.equal(out.status, 2, out.stdout);
  assert.match(board(root, "draft", "list").stdout, /rule/);
});

test("apply and drop name a pending draft by a plain number", () => {
  const { root } = fresh();
  for (const n of ["0", "-1", "x", "1.5"])
    assert.equal(board(root, "draft", "drop", n).status, 2, n);
  assert.equal(board(root, "draft", "drop", "7").status, 2);
  assert.equal(board(root, "draft", "drop").status, 2);
  assert.equal(board(root, "draft").status, 2);
});

test("a line that is not a draft is kept as written on drop and apply, and named in the output", () => {
  const { root } = fresh();
  add(root, { kind: "rule", answer: "A" });
  const file = join(root, ".agentry", "run", "process", "drafts.jsonl");
  const torn = '{"n":2,"kind":"rule","ans';
  writeFileSync(file, `${readFileSync(file, "utf8")}${torn}`); // torn: no newline at the end
  add(root, { kind: "rule", answer: "B" });
  assert.deepEqual(
    drafts.list(root).map((d) => d.answer),
    ["A", "B"],
    "the new draft is not glued onto the torn line",
  );
  const drop = board(root, "draft", "drop", "1");
  assert.match(drop.stdout, /^dropped draft 1\nnote: drafts\.jsonl line 2 could not be read; kept/);
  const apply = board(root, "draft", "apply", String(drafts.pending(root)[0].n), "--apply");
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /line 2 could not be read/);
  assert.equal(readFileSync(file, "utf8").split("\n")[1], torn);
  assert.deepEqual(drafts.unreadable(root), [2]);
  assert.match(board(root, "draft", "list").stdout, /^no pending drafts\nnote: .*line 2/);
});

test("apply from inside a worktree refuses: the edit and the run state stay in one checkout", () => {
  const { root } = fresh();
  const { path } = builtBranch(root, "T1");
  add(path, { kind: "rule", answer: "From a worktree." });
  const before = [read(root, "CONDUCTOR.md"), read(path, "CONDUCTOR.md")];
  const out = board(path, "draft", "apply", "1", "--apply");
  assert.equal(out.status, 2);
  assert.match(out.stderr, /is a worktree: run it from /);
  assert.deepEqual([read(root, "CONDUCTOR.md"), read(path, "CONDUCTOR.md")], before);
  assert.equal(drafts.pending(root).length, 1, "still pending in the main checkout");
  assert.equal(board(root, "draft", "apply", "1", "--apply").status, 0, "and applies from there");
  assert.match(read(root, "CONDUCTOR.md"), /- From a worktree\./);
});

test("a rewrite killed between write and rename leaves a temp file the next read removes", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentry-drafts-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  drafts.add(dir, DECISION);
  const at = join(dir, ".agentry", "run", "process");
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  const live = `drafts.jsonl.agentry-${process.ppid}.tmp`;
  writeFileSync(join(at, `drafts.jsonl.agentry-${dead}.tmp`), "{half");
  writeFileSync(join(at, live), "{");
  assert.equal(drafts.pending(dir).length, 1);
  assert.deepEqual(readdirSync(at).sort(), ["drafts.jsonl", live], "a live writer's temp stays");
});
