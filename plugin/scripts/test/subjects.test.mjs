// subjects — the workflow file's `commits` rules applied to messages: `checkCommits` (pure) with each
// reason it gives, the length counted in code points, the regex flags, and `readCommits`/`brokenIn` on a
// real repo; the rules learned from a history (`learnRules`), a pattern widened to a type (`withType`) and
// the type hint on a commit that fails the pattern (`withTypeHints`).
// Run: node --test plugin/scripts/test/subjects.test.mjs
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  brokenIn,
  checkCommits,
  readCommits,
  rulesOf,
  withType,
  withTypeHints,
} from "../lib/lane/subjects.mjs";
import { STANDARD_TYPES, historySubjects, learnRules, typeOf } from "../lib/process/commits.mjs";
import { commitFile, git, tempRepo } from "./git-repo.mjs";

const c = (message, sha = "a".repeat(40)) => ({ sha, message });
const whyOf = (rules, message) => checkCommits(rules, [c(message)])[0]?.why;

test("subjectMax: a 72 code point subject with é and an emoji passes, 73 fails with its length", () => {
  const rules = { subjectMax: 72 };
  const body = (n) => `é😀${"x".repeat(n - 2)}`;
  assert.equal(whyOf(rules, body(72)), undefined);
  assert.equal(whyOf(rules, body(73)), "subject is 73 chars (commits.subjectMax 72)");
  assert.equal(whyOf(rules, "x".repeat(81)), "subject is 81 chars (commits.subjectMax 72)");
});

test("the subject is the first line only: a long body does not count, a CRLF's \\r does not", () => {
  const rules = { subjectMax: 10 };
  assert.equal(whyOf(rules, `${"x".repeat(10)}\n\n${"y".repeat(200)}`), undefined);
  assert.equal(whyOf(rules, `${"x".repeat(10)}\r\n\r\nbody`), undefined);
  assert.equal(
    whyOf(rules, `${"x".repeat(11)}\r\nbody`),
    "subject is 11 chars (commits.subjectMax 10)",
  );
  assert.equal(checkCommits(rules, [c(`${"x".repeat(11)}\r\nbody`)])[0].subject, "x".repeat(11));
});

test("subjectPattern: compiled with no flags, so case counts; an empty subject fails it", () => {
  const rules = { subjectPattern: "^feat" };
  assert.equal(whyOf(rules, "feat: x"), undefined);
  assert.equal(whyOf(rules, "Feat: x"), "subject does not match commits.subjectPattern");
  assert.equal(whyOf(rules, ""), "subject does not match commits.subjectPattern");
  // matched against the subject alone, not the body
  assert.equal(
    whyOf(rules, "fix: x\n\nfeat: in the body"),
    "subject does not match commits.subjectPattern",
  );
});

test("forbid: checked on the whole message with ^ and $ at each line, the first pattern that matches is named", () => {
  const rules = { forbid: ["^never$", "^Co-Authored-By:"] };
  const trailer = "feat: x\n\nbody\n\nCo-Authored-By: Someone <a@b.c>";
  assert.equal(whyOf(rules, trailer), "message matches commits.forbid[1]");
  assert.equal(whyOf(rules, "feat: x\n\nnever"), "message matches commits.forbid[0]");
  assert.equal(whyOf(rules, "feat: x\n\nnot never ok"), undefined);
  assert.equal(whyOf(rules, "feat: x\n\nco-authored-by: lower"), undefined, "no i flag");
});

test("the first rule broken is the one named: length, then pattern, then forbid", () => {
  const rules = { subjectMax: 5, subjectPattern: "^feat", forbid: ["x"] };
  assert.match(whyOf(rules, "fixxxxxxx"), /^subject is 9 chars/);
  assert.equal(whyOf(rules, "fix x"), "subject does not match commits.subjectPattern");
  assert.equal(whyOf(rules, "feat\n\nx"), "message matches commits.forbid[0]");
  assert.equal(whyOf(rules, "feat\n\ny"), undefined);
});

test("no rule set checks nothing; each broken commit is returned once with its sha and subject", () => {
  assert.deepEqual(checkCommits({}, [c("anything at all, however long ".repeat(9))]), []);
  const out = checkCommits({ subjectMax: 3 }, [
    c("ok", "1".repeat(40)),
    c("too long\n\nbody", "2".repeat(40)),
    c("also too long", "3".repeat(40)),
  ]);
  assert.deepEqual(
    out.map(({ sha, subject }) => [sha[0], subject]),
    [
      ["2", "too long"],
      ["3", "also too long"],
    ],
  );
});

const repos = [];
after(() => {
  for (const r of repos) r.cleanup();
});
const repo = () => {
  const r = tempRepo();
  repos.push(r);
  return r;
};

test("readCommits reads each message whole, in the order given; brokenIn applies the spec's rules", () => {
  const { dir } = repo();
  const a = commitFile(dir, "a.txt", "a", "feat: fine");
  const b = commitFile(dir, "b.txt", "b", `fix: ${"y".repeat(80)}`);
  git(dir, "commit", "--allow-empty", "-q", "-m", "chore: sub", "-m", "body line\n\nTrailer: yes");
  const c3 = git(dir, "rev-parse", "HEAD");
  assert.deepEqual(
    readCommits(dir, [b, a]).map((x) => x.sha),
    [b, a],
  );
  assert.equal(readCommits(dir, [c3])[0].message, "chore: sub\n\nbody line\n\nTrailer: yes");
  assert.deepEqual(readCommits(dir, []), []);
  const spec = { commits: { subjectMax: 72, forbid: ["^Trailer:"] } };
  assert.deepEqual(
    brokenIn(dir, spec, [a, b, c3]).map((x) => [x.sha, x.why]),
    [
      [b, "subject is 85 chars (commits.subjectMax 72)"],
      [c3, "message matches commits.forbid[0]"],
    ],
  );
  assert.deepEqual(brokenIn(dir, {}, [a, b, c3]), [], "no commits key, no rules");
  assert.equal(rulesOf({}), null);
});

test("a git show that fails is one broken entry with git's first error line, so nothing passes unread", () => {
  const { dir } = repo();
  const a = commitFile(dir, "a.txt", "a", "feat: fine");
  const bogus = "0".repeat(40);
  const spec = { commits: { subjectMax: 72 } };
  const out = brokenIn(dir, spec, [a, bogus]);
  assert.equal(out.length, 1);
  assert.equal(out[0].sha, bogus, "the entry names the sha whose git show failed");
  assert.equal(out[0].subject, "");
  assert.match(out[0].why, /^git show failed: \S/);
  assert.ok(!out[0].why.includes("\n"));
  assert.deepEqual(brokenIn(dir, spec, [a]), [], "a good read still passes");
});

test("typeOf reads the word before a ( or a : (a breaking ! allowed), and nothing else", () => {
  assert.equal(typeOf("feat(core): x"), "feat");
  assert.equal(typeOf("art: x"), "art");
  assert.equal(typeOf("fix!: x"), "fix");
  assert.equal(typeOf("ci-bot(x): y"), "ci-bot");
  for (const none of ["Merge branch 'x'", "add a file", ": x", "1fix: x", "", "v1.2: x"])
    assert.equal(typeOf(none), null, none);
});

const many = (subject, n) => Array.from({ length: n }, () => subject);

test("learnRules: the standard types, each with its count, then a type used --min times or more", () => {
  const subjects = [...many("feat: a", 4), ...many("art(lvl): b", 3), "fix: c", "Merge branch 'x'"];
  const rules = learnRules(subjects, { min: 3 });
  assert.deepEqual(
    rules.types.map((t) => [t.type, t.count, t.standard]),
    [...STANDARD_TYPES.map((t) => [t, { feat: 4, fix: 1 }[t] ?? 0, true]), ["art", 3, false]],
  );
  assert.equal(
    rules.subjectPattern,
    `^(${[...STANDARD_TYPES, "art"].join("|")})(\\([^)]+\\))?!?: `,
  );
  for (const ok of ["art(lvl): b", "feat: a", "fix!: c"])
    assert.match(ok, new RegExp(rules.subjectPattern));
  assert.doesNotMatch("Merge branch 'x'", new RegExp(rules.subjectPattern));
});

test("learnRules: a type used fewer than --min times is not added; --min sets the bar", () => {
  const subjects = [...many("art: a", 2), ...many("wip: b", 5), "feat: c"];
  const at3 = learnRules(subjects, { min: 3 });
  assert.deepEqual(
    at3.types.filter((t) => !t.standard).map((t) => t.type),
    ["wip"],
  );
  assert.doesNotMatch("art: a", new RegExp(at3.subjectPattern));
  const at2 = learnRules(subjects, { min: 2 });
  assert.deepEqual(
    at2.types.filter((t) => !t.standard).map((t) => [t.type, t.count]),
    [
      ["wip", 5],
      ["art", 2],
    ],
    "most used first",
  );
  assert.equal(
    learnRules(subjects).types.some((t) => t.type === "art"),
    false,
    "the default bar is 3",
  );
});

test("learnRules: scoped only when every typed subject has a scope, and then the pattern needs one", () => {
  const scoped = learnRules(["feat(a): x", "fix(b): y", "plain words"]);
  assert.equal(scoped.scoped, true);
  assert.doesNotMatch("feat: x", new RegExp(scoped.subjectPattern));
  assert.match("feat(a): x", new RegExp(scoped.subjectPattern));
  assert.equal(learnRules(["feat(a): x", "fix: y"]).scoped, false);
  assert.equal(learnRules(["plain words"]).scoped, false, "no typed subject, no scope rule");
});

test("learnRules: subjectMax is 72, however short or long the history's subjects are", () => {
  assert.equal(learnRules(["feat: short"]).subjectMax, 72);
  assert.equal(learnRules([...many("feat: x", 9), `feat: ${"y".repeat(90)}`]).subjectMax, 72);
  assert.equal(learnRules(many(`feat: ${"y".repeat(90)}`, 5)).subjectMax, 72);
});

test("learnRules with no history is the standard set: every count 0, no scope rule, 72", () => {
  const rules = learnRules([]);
  assert.deepEqual(
    rules.types.map((t) => [t.type, t.count, t.standard]),
    STANDARD_TYPES.map((t) => [t, 0, true]),
  );
  assert.equal(rules.scoped, false);
  assert.equal(rules.subjectMax, 72);
  assert.equal(rules.subjectPattern, `^(${STANDARD_TYPES.join("|")})(\\([^)]+\\))?!?: `);
});

test("withType adds the type to the pattern's first word group, else as an alternative of the whole", () => {
  assert.equal(withType("^(feat|fix)\\(.+\\): ", "art"), "^(feat|fix|art)\\(.+\\): ");
  assert.equal(withType("^(?:feat|fix): ", "art"), "^(?:feat|fix|art): ");
  assert.equal(withType("^(feat|fix): ", "fix"), "^(feat|fix): ", "already there: unchanged");
  const whole = withType("^feat: ", "art");
  assert.match("feat: x", new RegExp(whole));
  assert.match("art(x): y", new RegExp(whole));
  assert.doesNotMatch("chore: y", new RegExp(whole));
});

test("withTypeHints: a type main uses gets the hint, with its count and the widened pattern", () => {
  const { dir } = repo();
  for (let i = 0; i < 3; i++) commitFile(dir, `a${i}.txt`, "a", `art: level ${i}`);
  commitFile(dir, "b.txt", "b", "lore: one");
  const rules = { subjectPattern: "^(feat|fix): ", subjectMax: 10 };
  const broken = checkCommits(rules, [
    c("art: x"),
    c("lore: y"),
    c("misc: z"),
    c(`feat: ${"x".repeat(20)}`),
  ]);
  const hints = withTypeHints(dir, "main", rules, broken).map((x) => x.hint);
  assert.deepEqual(hints, [
    'type "art" is used 3 times on main: add it to commits.subjectPattern? "^(feat|fix|art): "',
    'type "lore" is used 1 time on main: add it to commits.subjectPattern? "^(feat|fix|lore): "',
    null,
    null,
  ]);
  assert.match(
    "art: x",
    new RegExp(JSON.parse(hints[0].split("? ")[1])),
    "the pasted pattern takes it",
  );
});

test("withTypeHints never suggests a type that is not on main, nor one widening would not fix", () => {
  const { dir } = repo();
  commitFile(dir, "a.txt", "a", "feat: on main");
  git(dir, "switch", "-q", "-c", "side");
  commitFile(dir, "b.txt", "b", "art: only on a side branch");
  const rules = { subjectPattern: "^(feat|fix)\\(.+\\): " };
  const broken = checkCommits(rules, [c("art(x): y"), c("feat: no scope")]);
  assert.deepEqual(
    withTypeHints(dir, "main", rules, broken).map((x) => x.hint),
    [null, null],
    "art is not on main; feat is listed already, the scope is what fails",
  );
});

test("historySubjects reads the branch's first-parent subjects, newest first; [] for no branch", () => {
  const { dir } = repo();
  commitFile(dir, "a.txt", "a", "feat: one");
  git(dir, "switch", "-q", "-c", "side");
  commitFile(dir, "b.txt", "b", "art: side");
  git(dir, "switch", "-q", "main");
  git(dir, "merge", "-q", "--no-ff", "-m", "Merge side\n\nbody", "side");
  git(dir, "commit", "--allow-empty", "-q", "-m", "fix: two\r", "-m", "body");
  assert.deepEqual(historySubjects(dir, "main"), ["fix: two", "Merge side", "feat: one", "init"]);
  assert.deepEqual(historySubjects(dir, "nope"), []);
  assert.deepEqual(historySubjects(dir, null), []);
});
