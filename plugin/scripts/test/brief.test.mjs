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
  ownedFiles,
  recalledFacts,
  renderBrief,
  slotsOf,
  suggestBuilder,
} from "../lib/lane/brief.mjs";
import { readProcess } from "../lib/process/read.mjs";

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
  tip: "def5678",
  from: "/m/r1.report.md",
  reason: "a reason",
  resend: false,
  recheck: false,
  fail: false,
  guard: false,
  needed: false,
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
  const final = renderBrief("final", VALUES);
  assert.match(final, /^# Final verify T1, round 2/);
  assert.match(final, /before\nyou open the earlier reports: \/m\/r2\.report\.md/);
  assert.doesNotMatch(final, /## Recheck|^# Verify/m);
  assert.match(final, /try to prove it wrong/);
});
