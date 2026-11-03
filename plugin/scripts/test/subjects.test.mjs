// subjects — the workflow file's `commits` rules applied to messages: `checkCommits` (pure) with each
// reason it gives, the length counted in code points, the regex flags, and `readCommits`/`brokenIn` on a
// real repo. Run: node --test plugin/scripts/test/subjects.test.mjs
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { brokenIn, checkCommits, readCommits, rulesOf } from "../lib/lane/subjects.mjs";
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
