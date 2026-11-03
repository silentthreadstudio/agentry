// Tests for lib/lane/brief.mjs: the owned files read from a contract, the builder suggestion, decisions
// quoted from the board's decision kind by id, recalled facts gated on `memory.prime`, and the
// templates rendering with every slot filled.
// Run: node --test plugin/scripts/test/brief.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  TEMPLATES,
  citedDecisions,
  decisionKind,
  fill,
  notesSection,
  ownedFiles,
  recalledFacts,
  relatedNotes,
  renderBrief,
  slotsOf,
  suggestBuilder,
  withNew,
} from "../lib/lane/brief.mjs";
import { readProcess } from "../lib/process/read.mjs";
import { commitFile, git } from "./git-repo.mjs";

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "brief-"));
  temps.push(dir);
  return dir;
};

test("ownedFiles reads the backticked paths of the owns part, up to the next part", () => {
  const block = [
    "- **T1** (S1): **owns** `src/a.ts`, ★ `src/ui/b.css` (+`helper`), tests `test/a.test.ts`",
    "  · **exposes** `run(x)` · **deps** T0",
  ].join("\n");
  assert.deepEqual(ownedFiles(block), ["src/a.ts", "src/ui/b.css", "test/a.test.ts"]);
  assert.deepEqual(ownedFiles("- **Owns:** `a/b.mjs`, `a/b.mjs`, `c.md`.\n- **Exposes:** `x.y`"), [
    "a/b.mjs",
    "c.md",
  ]);
  assert.deepEqual(ownedFiles("no such part, but `a/b.ts` is named"), []);
  assert.deepEqual(ownedFiles(""), []);
});

test("ownedFiles keeps paths only: no symbols, string keys or negated spans; path:lines is the path", () => {
  const block = [
    "- **T2** (S1): **owns** `row1.tres`, `Desk.shown()`, `run.build.room().y`, `KEY_1/2`,",
    "  `src/strings/en.tres`, tests `tests/test_a.gd:289–301`, `tests/test_b.gd#L4-9`,",
    "  `scenes/*.tscn` + `.tscn`, `src/ui/`. (≤ 6 lines; T9's rule: no\n  line in `shell.gd`); never `src/main.gd`,",
    "  but `src/ok.gd` is owned. · **excludes** `src/other.gd`",
  ].join("\n");
  assert.deepEqual(ownedFiles(block), [
    "row1.tres",
    "src/strings/en.tres",
    "tests/test_a.gd",
    "tests/test_b.gd",
    "scenes/*.tscn",
    "src/ui/",
    "src/ok.gd",
  ]);
});

test("a closed aside or a comma-ended negation does not drop the next owned path", () => {
  const owned = (text) => ownedFiles(`**owns** ${text}`);
  assert.deepEqual(owned("`src/a.gd` (no new class), `src/b.gd`"), ["src/a.gd", "src/b.gd"]);
  assert.deepEqual(owned("`src/a.gd` (not more than 200 lines), `src/b.gd`"), [
    "src/a.gd",
    "src/b.gd",
  ]);
  assert.deepEqual(owned("`src/a.gd`, without touching the bus, `src/b.gd`"), [
    "src/a.gd",
    "src/b.gd",
  ]);
  // A negation still covers its whole list, and an aside that opens before the span still negates.
  assert.deepEqual(owned("`src/a.gd`, but not `src/b.gd`, `src/c.gd`"), ["src/a.gd"]);
  assert.deepEqual(owned("`src/a.gd` (but not `src/b.gd`), `src/c.gd`"), ["src/a.gd", "src/c.gd"]);
});

test("withNew resolves a bare name against the tracked files: one hit is that path, several are ambiguous, none is new", () => {
  const dir = temp();
  git(dir, "init", "-q");
  commitFile(dir, "data/rows/row1.tres", "");
  commitFile(dir, "src/a/run.gd", "");
  commitFile(dir, "src/b/run.gd", "");
  commitFile(dir, "top.gd", "");
  assert.deepEqual(withNew(dir, ["row1.tres", "run.gd", "fresh.gd", "top.gd", "src/x/y.gd"]), [
    { path: "data/rows/row1.tres", new: false },
    { path: "src/a/run.gd", new: false, ambiguous: true },
    { path: "src/b/run.gd", new: false, ambiguous: true },
    { path: "fresh.gd", new: true },
    { path: "top.gd", new: false },
    { path: "src/x/y.gd", new: true },
  ]);
});

test("withNew: a path that is the tail of exactly one tracked file resolves to it, several are ambiguous, none is new", () => {
  const dir = temp();
  git(dir, "init", "-q");
  commitFile(dir, "plugin/lib/merge/gating.mjs", "");
  commitFile(dir, "plugin/lib/a/cli/exec.mjs", "");
  commitFile(dir, "plugin/lib/b/cli/exec.mjs", "");
  assert.deepEqual(withNew(dir, ["merge/gating.mjs", "cli/exec.mjs", "merge/other.mjs"]), [
    { path: "plugin/lib/merge/gating.mjs", new: false },
    { path: "plugin/lib/a/cli/exec.mjs", new: false, ambiguous: true },
    { path: "plugin/lib/b/cli/exec.mjs", new: false, ambiguous: true },
    { path: "merge/other.mjs", new: true },
  ]);
});

test("withNew: a glob or folder resolves by its folders; a top folder that exists at the root is kept", () => {
  const dir = temp();
  git(dir, "init", "-q");
  commitFile(dir, "plugin/skills/conducting/SKILL.md", "");
  commitFile(dir, "plugin/skills/conducting/references/a.md", "");
  commitFile(dir, "plugin/scripts/x.mjs", "");
  commitFile(dir, "scripts/check.mjs", "");
  commitFile(dir, "a/docs/x.md", "");
  commitFile(dir, "b/docs/y.md", "");
  assert.deepEqual(
    withNew(dir, [
      "skills/conducting/references/*.md",
      "skills/conducting/",
      "scripts/**",
      "scripts/check.mjs",
      "docs/**",
      "nothing/**",
      "*.md",
    ]),
    [
      { path: "plugin/skills/conducting/references/*.md", new: false },
      { path: "plugin/skills/conducting/", new: false },
      { path: "scripts/**", new: false },
      { path: "scripts/check.mjs", new: false },
      { path: "a/docs/**", new: false, ambiguous: true },
      { path: "b/docs/**", new: false, ambiguous: true },
      { path: "nothing/**", new: false },
      { path: "*.md", new: false },
    ],
  );
});

test("ownedFiles expands a brace glob into each path, in order", () => {
  assert.deepEqual(
    ownedFiles("**Owns:** `commands/{go,spec}.md`, `x.mjs`, `skills/{a,b}/SKILL.md`."),
    ["commands/go.md", "commands/spec.md", "x.mjs", "skills/a/SKILL.md", "skills/b/SKILL.md"],
  );
  assert.deepEqual(ownedFiles("**Owns:** `x.mjs`, but not `commands/{go,spec}.md`"), ["x.mjs"]);
  assert.deepEqual(ownedFiles("**Owns:** `{ a, b }`, `fn({x})`"), []);
});

test("ownedFiles reads a code span that wraps across one line break, never across a blank line", () => {
  // The shape of a real owns paragraph: a brace span broken over two lines, more spans after it.
  const block = [
    "- **Owns:** `lib/a.json` (drop `x.y`), `docs/{one,two,three,",
    "  four}.md`, every file that calls it: `commands/{go,",
    "  spec}.md`, `agents/{p,q}.md`; `lib/b.mjs`.",
    "- **Exposes:** `z.mjs`",
  ].join("\n");
  assert.deepEqual(ownedFiles(block), [
    "lib/a.json",
    "docs/one.md",
    "docs/two.md",
    "docs/three.md",
    "docs/four.md",
    "commands/go.md",
    "commands/spec.md",
    "agents/p.md",
    "agents/q.md",
    "lib/b.mjs",
  ]);
  assert.ok(!ownedFiles("**Owns:** `a/b.md`, `c/d\n\ne.md`, `f.md`").includes("c/de.md"));
});

test("ownedFiles ends the owns part at an Interface label, and neither negates", () => {
  assert.deepEqual(ownedFiles("**Owns:** `a.ts`. **Interface:** neither lane writes `b.md`"), [
    "a.ts",
  ]);
  assert.deepEqual(ownedFiles("**Owns:** neither `a.ts`, `c.ts`"), []);
});

test("ownedFiles stops the owns clause at a ` · `, and at a bold label but not at emphasis", () => {
  assert.deepEqual(ownedFiles("**T1** · owns `a.ts`, `b.ts` · deps `c.ts` · accept `d.ts`"), [
    "a.ts",
    "b.ts",
  ]);
  const block = [
    "**Owns:** `a.ts`, the same **object** in `b.ts`.",
    "**Strings** (draft): `c.ts`",
  ].join("\n");
  assert.deepEqual(ownedFiles(block), ["a.ts", "b.ts"]);
  // A title that says "our own" is not the clause.
  assert.deepEqual(ownedFiles("**T2 · Make it our own** (P1) · owns `a.ts` · deps T1"), ["a.ts"]);
});

test("ownedFiles keeps the files of every step the clause names", () => {
  const block = [
    "**T3 · Two steps**",
    "**step 1 owns:** `src/mock.ts`",
    "**step 2 owns:**",
    "- New `src/feature.ts`",
    "- `src/shell.ts` (294 -> **<= 297**)",
    "**deps:** T1",
  ].join("\n");
  assert.deepEqual(ownedFiles(block), ["src/mock.ts", "src/feature.ts", "src/shell.ts"]);
});

test("ownedFiles drops a path that is only cited with a :NN, and one inside an aside that cites or says what stays", () => {
  assert.deepEqual(ownedFiles("**Owns:** `a/b.ts` (`:48,:75`), `a/c.ts`:12, `a/d.ts`"), ["a/d.ts"]);
  assert.deepEqual(ownedFiles("**Owns:** `a/b.ts` (the host, `a/ctx.ts:61,90`), `a/e.ts`"), [
    "a/b.ts",
    "a/e.ts",
  ]);
  assert.deepEqual(
    ownedFiles(
      "**Owns:** `a/b.ts`; `x.key` stays, because kit tests pin it (`t/one.ts:86-88`, `t/two.ts:9`), `a/f.ts`",
    ),
    ["a/b.ts", "a/f.ts"],
  );
  assert.deepEqual(ownedFiles("**Owns:** `a/b.ts` (`t/other.ts` stays as it is), `a/g.ts`"), [
    "a/b.ts",
    "a/g.ts",
  ]);
  // An aside with no citation names what is owned; so does an inline path:lines outside any aside.
  assert.deepEqual(
    ownedFiles("**Owns:** the raws (`art/one/`, `art/two/`), `t/x.ts:10-20` rewritten"),
    ["art/one/", "art/two/", "t/x.ts"],
  );
  assert.deepEqual(
    ownedFiles(
      "**Owns:** a new pure `a/flags.ts` (to stay near its cap, split out of `a/main.ts`)",
    ),
    ["a/flags.ts", "a/main.ts"],
  );
});

test("ownedFiles on a step contract: owned files once each, cited and kept-as-is files left out", () => {
  const block = [
    "**NEW-1 · Wipe the save** (P2; step 1 is a mock)",
    "",
    "On the title, New game wipes the profile (`src/core/keeper.ts:40`).",
    "",
    "**step 1 (no code):**",
    "- A mock in `src/debug/mock_home.ts` plus its line in `src/debug/mock_shots.ts`.",
    "",
    "**step 2 owns:**",
    "- New `src/main/new_game.ts`, beside the intro gate:",
    "  - the wipe: `keeper.wipe()`; the intro gate (`src/main/intro_gate.ts:38-46`, `src/main/shell.ts:10`);",
    "- `src/main/committer.ts` (155 -> <= 175), *proposed* `wipe()`:",
    "  - puts `profile` back **in place**, the object the flow holds (`src/main/flow.ts:61,90`);",
    "  - uses the copy `discard` already does (`committer.ts:80-89`).",
    "- `src/main/shell.ts` (294 -> **<= 297**): `_intro` (`:48,:75`) becomes `_new_game`.",
    "- `i18n/strings.csv`: new rows. `MENU_OLD` stays, because kit tests pin it",
    "  (`tests/kit_a.ts:86-88`, `tests/kit_b.ts:286`).",
    "- Tests: new `tests/new_game.ts`; the cases of `tests/shell.ts:208-271` rewritten.",
    "",
    "**strings** (draft): `src/ui/copy.ts`",
    "**deps:** NEW-0",
    "**accept:** `src/main/other.ts` is untouched",
  ].join("\n");
  assert.deepEqual(ownedFiles(block), [
    "src/main/new_game.ts",
    "src/main/committer.ts",
    "src/main/shell.ts",
    "i18n/strings.csv",
    "tests/new_game.ts",
    "tests/shell.ts",
  ]);
});

test("ownedFiles caps a brace expansion at 64 paths", () => {
  assert.equal(ownedFiles("**Owns:** `{a,b,c,d}/{a,b,c,d}/{a,b,c,d}/{a,b,c,d}.md`").length, 64);
});

test("ownedFiles: a.b.c-shaped symbols are paths only when a tracked file matches; extensionless known files are paths", () => {
  const dir = temp();
  git(dir, "init", "-q");
  commitFile(dir, "docs/notes.draft.md", "");
  commitFile(dir, "bin/runner", "");
  const block =
    "**Owns:** `config.items.go`, `a.b.c`, `notes.draft.md`, `new.test.mjs`, `Makefile`, `runner`, `LICENSE`, `word`, `index.d.ts`, `.eslintrc.json`";
  assert.deepEqual(ownedFiles(block, dir), [
    "notes.draft.md",
    "new.test.mjs",
    "Makefile",
    "LICENSE",
    "index.d.ts",
    ".eslintrc.json",
  ]);
  // Without a tree nothing can match: only the shapes that need no tree are paths.
  assert.deepEqual(ownedFiles(block), [
    "new.test.mjs",
    "Makefile",
    "LICENSE",
    "index.d.ts",
    ".eslintrc.json",
  ]);
  // A bare word is not a tracked extensionless file (`runner` in prose); a tracked dotfile is a path.
  commitFile(dir, "pkg/.srchash", "");
  assert.deepEqual(ownedFiles("**Owns:** `runner`, `.srchash`, `bin/runner`", dir), [
    ".srchash",
    "bin/runner",
  ]);
});

test("withNew marks a plain file the tree lacks, never an existing file, a glob or a folder", () => {
  const dir = temp();
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "old.ts"), "");
  assert.deepEqual(withNew(dir, ["src/old.ts", "src/new.ts", "src/*.ts", "src/"]), [
    { path: "src/old.ts", new: false },
    { path: "src/new.ts", new: true },
    { path: "src/*.ts", new: false },
    { path: "src/", new: false },
  ]);
});

test("suggestBuilder: a UI-shaped owned path suggests the designer, else the implementer", () => {
  assert.equal(suggestBuilder(["src/ui/panel.gd"]).agent, "designer");
  assert.equal(suggestBuilder(["web/components/Card.vue"]).agent, "designer");
  assert.equal(suggestBuilder(["scenes/menu.tscn"]).agent, "designer");
  assert.match(suggestBuilder(["a/Styles/x.ts"]).why, /UI-shaped/);
  assert.deepEqual(suggestBuilder(["src/domain/rules.ts"]), {
    agent: "implementer",
    why: "no owned path is UI-shaped",
  });
  assert.equal(suggestBuilder([]).agent, "implementer");
});

test("suggestBuilder: .astro, .svelte, .vue and .css files, and globs under a web, app or ui folder, suggest the designer", () => {
  for (const path of ["src/pages/Home.astro", "src/Nav.svelte", "src/Nav.vue", "theme.css"])
    assert.equal(suggestBuilder([path]).agent, "designer", path);
  for (const path of ["web/**", "packages/web/src/*.ts", "app/**", "ui/**"])
    assert.equal(suggestBuilder([path]).agent, "designer", path);
  // A plain file under app/ is not enough: only a glob names a whole front end there.
  assert.equal(suggestBuilder(["app/models/user.rb"]).agent, "implementer");
  assert.equal(suggestBuilder(["website/**", "src/**"]).agent, "implementer");
});

const DECISIONS = `# Decisions

## Log

| # | Decision | Why |
|---|---|---|
| 1 | **Plain files** for the board | Diffable |
| 12 | The clock pauses | Asked |
| 3 | Unused | — |
`;
function board(spec) {
  const root = temp();
  mkdirSync(join(root, "plan"));
  writeFileSync(join(root, "plan", "DECISIONS.md"), DECISIONS);
  return { root, model: readProcess({ root, spec }) };
}
const decisionSpec = (extra = {}) => ({
  version: 1,
  name: "D",
  root: "plan",
  kinds: {
    log: {
      label: "Decision",
      at: { table: "DECISIONS.md", heading: "Log" },
      id: { column: "#", prefix: "D" },
      fields: { decision: { column: "Decision" }, why: { column: "Why" } },
    },
  },
  rules: [],
  drafts: { decision: { kind: "log", map: { decision: "{answer}" } } },
  ...extra,
});

test("citedDecisions quotes each decision the block cites by its prefixed id, row verbatim", () => {
  const spec = decisionSpec();
  const { root, model } = board(spec);
  const cited = citedDecisions({
    root,
    spec,
    model,
    block: "follows D12 and D1 (not D13, D1a or XD3)",
  });
  assert.deepEqual(cited, [
    { id: "D1", text: "| 1 | **Plain files** for the board | Diffable |" },
    { id: "D12", text: "| 12 | The clock pauses | Asked |" },
  ]);
  assert.deepEqual(citedDecisions({ root, spec, model, block: "cites nothing" }), []);
});

test("citedDecisions never matches a digits-only id in prose", () => {
  const spec = decisionSpec();
  spec.kinds.log.id = { column: "#" };
  const { root, model } = board(spec);
  assert.deepEqual(citedDecisions({ root, spec, model, block: "step 1 then 12" }), []);
});

test("decisionKind: the kind drafts.decision names, else one called decision, else none", () => {
  assert.equal(decisionKind(decisionSpec()), "log");
  const plain = decisionSpec({ drafts: undefined });
  assert.equal(decisionKind(plain), null);
  plain.kinds.decision = plain.kinds.log;
  assert.equal(decisionKind(plain), "decision");
  assert.equal(decisionKind({ kinds: {}, drafts: { decision: { kind: "toString" } } }), null);
});

function store(prime) {
  const root = temp();
  const facts = join(root, ".agentry", "memory", "facts");
  mkdirSync(facts, { recursive: true });
  writeFileSync(
    join(root, ".agentry", "config.json"),
    JSON.stringify({ memory: { prime, primeLimit: 3 } }),
  );
  writeFileSync(
    join(facts, "g1.md"),
    "---\nid: g:01FIXTURE\ntype: gotcha\nconfidence: 0.9\nprovenance:\n  - src/engine/saver.ts\n---\nThe saver writes atomically; never call it twice in one frame.\n",
  );
  return root;
}

test("recalledFacts brings the ranked facts only when memory.prime is all", () => {
  const owned = ["src/engine/saver.ts"];
  const all = recalledFacts(store("all"), { owned, block: "- **T1**: owns `src/engine/saver.ts`" });
  assert.equal(all.prime, "all");
  assert.deepEqual(
    all.facts.map((f) => f.id),
    ["g:01FIXTURE"],
  );
  for (const prime of ["off", "conductor"]) {
    const none = recalledFacts(store(prime), { owned, block: "" });
    assert.deepEqual(none, { prime, facts: [] });
  }
});

test("fill: every slot needs a value; sections keep or drop; an empty slot line leaves no gap", () => {
  assert.throws(() => fill("{{a}} {{b}}", { a: 1 }), /without a value: b/);
  assert.throws(() => fill("{{#s}}\nx\n{{/s}}\n", {}), /without a value: s/);
  const template =
    "Top\n\n{{#on}}\nkept {{v}}\n\n{{/on}}\n{{#off}}\ngone\n{{/off}}\n{{note}}\n\nEnd {{v}}\n";
  assert.equal(
    fill(template, { on: true, off: false, v: "x", note: "" }),
    "Top\n\nkept x\n\nEnd x\n",
  );
  assert.equal(
    fill("A\n{{block}}\nB", { block: "line 1\n\n\n\nline 2 {{v}}" }),
    "A\nline 1\n\n\n\nline 2 {{v}}\nB\n",
    "values go in as given, never re-filled or collapsed",
  );
  assert.deepEqual(slotsOf("{{a}} {{#b}}\n{{c}}\n{{/b}} {{a}}"), ["a", "b", "c"]);
});

// The slots the CLI fills (cli/exec.mjs `brief`); each template may use only these.
const VALUES = {
  id: "T1",
  round: 2,
  contract: "plan/TASKS.md:3",
  block: "- **T1**: owns `a.txt`",
  owned: "- `a.txt`",
  decisions: "none",
  facts: "none",
  worktree: "/w",
  cd: "cd '/w'",
  branch: "agentry/T1",
  base: "abc1234",
  mainRoot: "/m",
  logDir: "/m/logs",
  reportPath: "/m/r2.report.md",
  gateLine: "cd /w && gate",
  gateGreen: false,
  gateRun: true,
  gateSha: "",
  gateLog: "",
  tip: "def5678",
  from: "/m/r1.report.md",
  reason: "a reason",
  resend: false,
  recheck: false,
  fail: false,
  guard: false,
  needed: false,
  related: false,
  notes: "",
  picked: false,
  pickedNotes: "",
  builderReport: "/m/r1.report.md",
  earlier: "/m/r2.report.md",
};

test("every template uses only the slots the CLI fills, and renders with none left", () => {
  const known = new Set([...Object.keys(VALUES), "inner"]);
  for (const file of readdirSync(TEMPLATES)) {
    const extra = slotsOf(readFileSync(join(TEMPLATES, file), "utf8")).filter((s) => !known.has(s));
    assert.deepEqual(extra, [], `${file} uses unknown slots`);
  }
  for (const step of ["build", "fix", "needs-context", "verify", "recheck", "final"]) {
    const text = renderBrief(step, {
      ...VALUES,
      [step === "needs-context" ? "needed" : "x"]: true,
    });
    assert.doesNotMatch(text, /\{\{/, step);
    assert.match(text, /- \*\*T1\*\*: owns `a\.txt`/, `${step} carries the block`);
    assert.match(text, /\/m\/r2\.report\.md/, `${step} names the report path`);
  }
  assert.throws(() => renderBrief("merge", VALUES), /no brief template/);
});

test("the brief rules are in the templates: cd prefix, foreground checks, logs, no rebase, gate, probes", () => {
  const build = renderBrief("build", VALUES);
  assert.match(build, /Prefix every shell command with `cd '\/w' &&`/);
  assert.match(build, /foreground and read each exit code/);
  assert.match(build, /Never pipe a check into `grep`, `tail`/);
  assert.match(build, /Logs and scratch files go only under \/m\/logs/);
  assert.match(build, /Do not merge, push or rebase/);
  assert.match(build, /cd \/w && gate/);
  const verify = renderBrief("verify", VALUES);
  assert.match(verify, /Run the gate as the lane records it.*\n?.*cd \/w && gate/);
  assert.match(verify, /fix round can commit it as a test/);
  assert.match(verify, /write down the bar first/);
  assert.match(verify, /very last line, exactly one of `Verdict: PASS`/);
});

test("a fix brief wraps the build brief; its sections follow the round's kind", () => {
  const fail = renderBrief("fix", { ...VALUES, fail: true });
  assert.match(fail, /^# Fix T1, round 2/);
  assert.match(fail, /The verifier's FAIL is in \/m\/r1\.report\.md/);
  assert.doesNotMatch(fail, /Refused report|Supplied context|^# Build/m);
  assert.match(fail, /## The contract/);
  const guard = renderBrief("fix", { ...VALUES, guard: true });
  assert.match(guard, /The lane refused your last report \(\/m\/r1\.report\.md\): a reason/);
  const needed = renderBrief("needs-context", { ...VALUES, needed: true });
  assert.match(needed, /under "The fact"/);
  const resent = renderBrief("build", { ...VALUES, resend: true });
  assert.match(
    resent,
    /## Sent back\nYour last report \(\/m\/r1\.report\.md\) was not readable: a reason/,
  );
});

test("a recheck brief names the earlier report; a final brief wraps the verify brief, recheck off", () => {
  const recheck = renderBrief("recheck", { ...VALUES, recheck: true });
  assert.match(
    recheck,
    /## Recheck\n\nYou verified this branch before; your report is \/m\/r1\.report\.md/,
  );
  const picked = renderBrief("recheck", {
    ...VALUES,
    recheck: true,
    picked: true,
    pickedNotes: "- N2: the reset path skips the queue",
  });
  assert.match(picked, /## Notes sent back\n[\s\S]*\n- N2: the reset path skips the queue/);
  assert.doesNotMatch(recheck, /Notes sent back/);
  const final = renderBrief("final", VALUES);
  assert.match(final, /^# Final verify T1, round 2/);
  assert.match(final, /before\nyou open the earlier reports: \/m\/r2\.report\.md/);
  assert.doesNotMatch(final, /## Recheck|^# Verify/m);
  assert.match(final, /try to prove it wrong/);
});

test("relatedNotes reads each related line verbatim; one that can't be read is left out", () => {
  const root = temp();
  writeFileSync(join(root, "NOTES.md"), "intro\n- **Q7** deps Q9 (accept as split)\n");
  assert.deepEqual(
    relatedNotes(root, [
      { file: "NOTES.md", line: 2 },
      { file: "NOTES.md", line: 9 },
      { file: "gone.md", line: 1 },
    ]),
    [{ at: "NOTES.md:2", text: "- **Q7** deps Q9 (accept as split)" }],
  );
  assert.deepEqual(relatedNotes(root, undefined), []);
});

test("notesSection lists file:line and text, cuts long lines, and says when it caps the list", () => {
  assert.equal(notesSection([]), "");
  assert.equal(notesSection([{ at: "N.md:2", text: "- Q7 narrowed" }]), "- N.md:2: - Q7 narrowed");
  const many = Array.from({ length: 11 }, (_, i) => ({
    at: `N.md:${i + 1}`,
    text: "x".repeat(500),
  }));
  const lines = notesSection(many).split("\n");
  assert.equal(lines.length, 9);
  assert.match(lines[0], /^- N\.md:1: x+… \(cut\)$/);
  assert.ok(lines[0].length < 450);
  assert.match(lines[8], /capped at 8: 3 more not shown/);
});

test("build and verify briefs (and the fix/final that wrap them) carry later notes only when given", () => {
  const given = {
    ...VALUES,
    related: true,
    notes: "- NOTES.md:2: - **Q7** deps Q9 (accept as split)",
  };
  for (const step of ["build", "fix", "verify", "final"]) {
    const text = renderBrief(step, given);
    assert.match(
      text,
      /## The contract\n\n.*\n\n## Later notes on this task\n\nThey override the contract where they conflict\.\n\n- NOTES\.md:2: - \*\*Q7\*\* deps Q9 \(accept as split\)\n\nOwned files:/s,
      step,
    );
    assert.doesNotMatch(renderBrief(step, VALUES), /Later notes/, `${step} without notes`);
  }
});

test("a verify brief on a tip with a recorded green gate says to read it, not re-run it", () => {
  const text = renderBrief("verify", {
    ...VALUES,
    gateGreen: true,
    gateRun: false,
    gateSha: "def5678",
    gateLog: "/m/logs/gate-1.log",
  });
  assert.match(
    text,
    /the gate is recorded green on def5678 \(\/m\/logs\/gate-1\.log\): read it; do not re-run it/,
  );
  assert.doesNotMatch(text, /Run the gate as the lane records it/);
});

test("a verify or final brief on a tip with no green gate keeps the full gate line", () => {
  for (const step of ["verify", "recheck", "final"]) {
    const text = renderBrief(step, VALUES);
    assert.match(text, /Run the gate as the lane records it, in the foreground/, step);
    assert.doesNotMatch(text, /do not re-run it/, step);
  }
});

test("the recheck and final briefs carry the recorded-green line too", () => {
  const green = { ...VALUES, gateGreen: true, gateRun: false, gateSha: "def5678", gateLog: "/l" };
  for (const step of ["recheck", "final"])
    assert.match(renderBrief(step, green), /do not re-run it/, step);
});
