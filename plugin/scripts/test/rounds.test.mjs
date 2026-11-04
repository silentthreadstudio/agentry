// Tests for lib/lane/rounds.mjs: every row of the exec round machine (plan R1b §3.2), driven through the
// pure (ledger, event) -> (ledger', next) seam with hand-made ledgers. No I/O.
// Run: node --test plugin/scripts/test/rounds.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_VERDICTS,
  addRound,
  begin,
  expects,
  gateTally,
  greenOn,
  notesBudget,
  step,
  verdicts,
} from "../lib/lane/rounds.mjs";

const TIP = "a".repeat(40);
const MOVED = "b".repeat(40);
const ok = { dirty: [], commits: 1 };

// A fresh lane with its first build round dispatched.
function lane() {
  const ledger = { v: 1, id: "T1", rounds: [], gates: [], state: "building", next: "build" };
  return dispatch(ledger, begin().dispatch);
}
let files = 0;
function dispatch(ledger, plan, tip = TIP) {
  files++;
  return addRound(ledger, plan, {
    brief: `/run/b${files}.md`,
    reportPath: `/run/r${files}.report.md`,
    tip,
    at: "t",
  });
}
// Step and, when the machine sends a round, dispatch it.
function go(ledger, event, tip = TIP) {
  const res = step(ledger, event);
  return { ...res, ledger: res.dispatch ? dispatch(res.ledger, res.dispatch, tip) : res.ledger };
}
const report = (status, guards = ok, extra = {}) => ({
  type: "report",
  status,
  report: "/r",
  guards,
  ...extra,
});
const judge = (verdict, tip = TIP, extra = {}) => ({
  type: "verdict",
  verdict,
  report: "/v",
  tip,
  gate: true,
  ...extra,
});
const green = (commit = TIP) => ({
  where: "worktree",
  exit: 0,
  cleanBefore: true,
  cleanAfter: true,
  commit,
  tier: "full",
});

test("start → build (fresh)", () => {
  const ledger = lane();
  assert.equal(ledger.next, "build");
  assert.equal(ledger.state, "building");
  assert.deepEqual(
    [ledger.rounds[0].n, ledger.rounds[0].role, ledger.rounds[0].mode],
    [1, "build", "fresh"],
  );
  assert.equal(expects(ledger), "report");
});

test("build DONE with the guards holding → verify (fresh); DONE_WITH_CONCERNS too", () => {
  for (const status of ["DONE", "DONE_WITH_CONCERNS"]) {
    const { ledger, next } = go(lane(), report(status));
    assert.equal(next, "verify");
    assert.deepEqual([ledger.rounds[1].role, ledger.rounds[1].mode], ["verify", "fresh"]);
    assert.equal(ledger.state, "verifying");
    assert.equal(expects(ledger), "verdict");
  }
});

test("the input ledger is never changed", () => {
  const before = lane();
  const copy = structuredClone(before);
  step(before, report("DONE"));
  assert.deepEqual(before, copy);
});

test("a fix with the guards holding → recheck, resuming the same verifier", () => {
  let { ledger } = go(lane(), report("DONE", ok, { agent: "builder-1" }));
  ({ ledger } = go(ledger, judge("FAIL", TIP, { agent: "verifier-1" })));
  assert.equal(ledger.next, "fix");
  const res = go(ledger, report("DONE"));
  assert.equal(res.next, "recheck");
  const round = res.ledger.rounds.at(-1);
  assert.deepEqual([round.role, round.mode, round.agent], ["verify", "resume", "verifier-1"]);
});

test("main touched → stop, whatever the builder reports", () => {
  for (const status of ["DONE", "NEEDS_CONTEXT", null]) {
    const res = go(lane(), report(status, { ...ok, mainTouched: "HEAD moved" }));
    assert.equal(res.next, "stop");
    assert.equal(res.ledger.state, "stopped");
    assert.match(res.reason, /main touched: HEAD moved/);
    assert.deepEqual(res.ledger.rounds[0].guards, ["main touched: HEAD moved"]);
  }
});

test("uncommitted files or no commits past base → fix (resume) with the reason; again → stop", () => {
  for (const guards of [
    { dirty: [" M a.txt"], commits: 1 },
    { dirty: [], commits: 0 },
  ]) {
    const first = go(lane(), report("DONE", guards, { agent: "builder-1" }));
    assert.equal(first.next, "fix");
    const round = first.ledger.rounds.at(-1);
    assert.deepEqual(
      [round.role, round.mode, round.guard, round.agent],
      ["build", "resume", true, "builder-1"],
    );
    assert.match(
      round.reason,
      guards.commits ? /uncommitted files in the worktree: {2}M a\.txt/ : /no commits past base/,
    );
    const again = go(first.ledger, report("DONE", guards));
    assert.equal(again.next, "stop");
    assert.match(again.reason, /again after a fix for it/);
  }
});

const broken = (n) =>
  Array.from({ length: n }, (_, i) => ({
    sha: `${(i + 1).toString(16).padStart(2, "0")}${"c".repeat(38)}`,
    subject: `subject ${i + 1}`,
    why: "subject is 81 chars (commits.subjectMax 72)",
  }));

test("a commit that breaks a commits rule → fix (resume) with its reason; the same again → stop; a reworded one goes on", () => {
  const bad = { ...ok, subjects: broken(1) };
  const first = go(lane(), report("DONE", bad, { agent: "b" }));
  assert.equal(first.next, "fix");
  const round = first.ledger.rounds.at(-1);
  assert.deepEqual([round.role, round.mode, round.guard], ["build", "resume", true]);
  assert.equal(
    round.reason,
    'commit 01ccccc "subject 1": subject is 81 chars (commits.subjectMax 72) → reword it on the branch (git commit --amend for the tip, or a rebase with exec, no -i)',
  );
  assert.deepEqual(first.ledger.rounds[0].guards, [round.reason]);
  const again = go(first.ledger, report("DONE", bad));
  assert.equal(again.next, "stop");
  assert.match(again.reason, /again after a fix for it/);
  // The fix rewords the subject: the lane goes on to the verifier.
  assert.equal(go(first.ledger, report("DONE", { ...ok, subjects: [] })).next, "verify");
  assert.equal(go(lane(), report("DONE", { ...ok, subjects: undefined })).next, "verify");
});

test("a dirty worktree and a bad subject are named together in one fix round", () => {
  const res = go(lane(), report("DONE", { dirty: [" M a.txt"], commits: 1, subjects: broken(1) }));
  assert.equal(res.next, "fix");
  const trips = res.ledger.rounds[0].guards;
  assert.equal(trips.length, 2);
  assert.match(trips[0], /uncommitted files in the worktree/);
  assert.match(trips[1], /^commit 01ccccc "subject 1": /);
  assert.equal(res.ledger.rounds.length, 2, "one fix round");
});

test("30 broken commits give one fix round listing 5 of them, then +25", () => {
  const res = go(lane(), report("DONE", { ...ok, subjects: broken(30) }));
  assert.equal(res.next, "fix");
  const trips = res.ledger.rounds[0].guards;
  assert.equal(trips.length, 6);
  assert.deepEqual(
    trips.slice(0, 5).map((t) => t.slice(0, 18)),
    ["01", "02", "03", "04", "05"].map((n) => `commit ${n}ccccc "su`),
  );
  assert.equal(trips[5], "+25");
  assert.equal(res.ledger.rounds.length, 2);
  // exactly 5 broken: no +N line
  assert.equal(
    go(lane(), report("DONE", { ...ok, subjects: broken(5) })).ledger.rounds[0].guards.length,
    5,
  );
});

test("NEEDS_CONTEXT → needs-context once (resume), then stop", () => {
  const first = go(lane(), report("NEEDS_CONTEXT", { dirty: [], commits: 0 }, { agent: "b" }));
  assert.equal(first.next, "needs-context");
  assert.deepEqual([first.ledger.rounds[1].role, first.ledger.rounds[1].mode], ["build", "resume"]);
  const second = go(first.ledger, report("NEEDS_CONTEXT", { dirty: [], commits: 0 }));
  assert.equal(second.next, "stop");
  assert.match(second.reason, /NEEDS_CONTEXT again/);
});

test("after the supplied fact, DONE goes on to verify", () => {
  const first = go(lane(), report("NEEDS_CONTEXT", { dirty: [], commits: 0 }));
  assert.equal(go(first.ledger, report("DONE")).next, "verify");
});

test("BLOCKED → stop", () => {
  const res = go(lane(), report("BLOCKED"));
  assert.equal(res.next, "stop");
  assert.match(res.reason, /BLOCKED/);
});

test("no status line → resend once (resume the same builder), then stop", () => {
  const first = go(lane(), report(null, ok, { agent: "b1" }));
  assert.equal(first.next, "resend");
  assert.equal(first.ledger.next, "resend");
  const round = first.ledger.rounds.at(-1);
  assert.deepEqual(
    [round.step, round.resend, round.mode, round.agent],
    ["build", true, "resume", "b1"],
  );
  const second = go(first.ledger, report(null));
  assert.equal(second.next, "stop");
  assert.match(second.reason, /sent back once/);
});

test("a resent builder that then reports DONE goes on to verify", () => {
  const first = go(lane(), report(null));
  assert.equal(go(first.ledger, report("DONE")).next, "verify");
});

test("verify / recheck / final: a moved tip voids the verdict → recheck", () => {
  const toVerify = go(lane(), report("DONE")).ledger;
  const res = go(toVerify, judge("PASS", MOVED, { agent: "v1" }), MOVED);
  assert.equal(res.next, "recheck");
  assert.equal(res.ledger.rounds[1].void, true);
  assert.equal(res.ledger.rounds[1].verdict, undefined);
  assert.equal(verdicts(res.ledger).length, 0);
  assert.match(res.reason, /moved from aaaaaaa to bbbbbbb/);
  const recheck = res.ledger.rounds.at(-1);
  assert.deepEqual([recheck.role, recheck.mode, recheck.agent], ["verify", "resume", "v1"]);

  // the same for a recheck and a final round
  let ledger = go(toVerify, judge("FAIL")).ledger;
  ledger = go(ledger, report("DONE")).ledger;
  assert.equal(go(ledger, judge("PASS", MOVED)).next, "recheck");
  ledger = go(ledger, judge("PASS")).ledger;
  assert.equal(ledger.next, "final");
  assert.equal(go(ledger, judge("PASS", MOVED)).next, "recheck");
});

test("verify PASS → gate when no green worktree gate is on this tip, close when one is", () => {
  const toVerify = go(lane(), report("DONE")).ledger;
  for (const verdict of ["PASS", "PASS WITH NOTES"]) {
    const res = go(toVerify, judge(verdict));
    assert.equal(res.next, "gate");
    assert.equal(res.ledger.state, "verifying");
  }
  const gated = step(toVerify, { type: "gate", record: green() }).ledger;
  assert.equal(gated.next, "verify", "a gate run mid-verify only records");
  const res = go(gated, judge("PASS"));
  assert.equal(res.next, "close");
  assert.equal(res.ledger.state, "verified");
  // a green gate on another commit, or a red one on this tip, does not count
  for (const record of [green(MOVED), { ...green(), exit: 1 }, { ...green(), cleanAfter: false }]) {
    const other = step(toVerify, { type: "gate", record }).ledger;
    assert.equal(go(other, judge("PASS")).next, "gate");
  }
});

test("no gate in the process file: a PASS closes on the verdict alone, and says so", () => {
  const toVerify = go(lane(), report("DONE")).ledger;
  const res = go(toVerify, judge("PASS", TIP, { gate: false }));
  assert.equal(res.next, "close");
  assert.match(res.reason, /no gate/);
});

test("the gate step: green on the verified tip → close; red or on another commit → stop", () => {
  const atGate = go(go(lane(), report("DONE")).ledger, judge("PASS")).ledger;
  assert.equal(expects(atGate), "gate");
  assert.equal(step(atGate, { type: "gate", record: green() }).next, "close");
  const red = step(atGate, { type: "gate", record: { ...green(), exit: 2 } });
  assert.equal(red.next, "stop");
  assert.match(red.reason, /red \(exit 2\)/);
  const moved = step(atGate, { type: "gate", record: green(MOVED) });
  assert.equal(moved.next, "stop");
  assert.match(moved.reason, /moved/);
  assert.equal(step(atGate, { type: "gate", record: green() }).ledger.gates.length, 1);
});

test("recheck PASS → final, a fresh verifier", () => {
  let ledger = go(lane(), report("DONE")).ledger;
  ledger = go(ledger, judge("FAIL")).ledger;
  ledger = go(ledger, report("DONE")).ledger;
  const res = go(ledger, judge("PASS WITH NOTES"));
  assert.equal(res.next, "final");
  const round = res.ledger.rounds.at(-1);
  assert.deepEqual([round.role, round.mode, round.final], ["verify", "fresh", true]);
});

test("final PASS → gate → close; final FAIL → stop", () => {
  let ledger = go(lane(), report("DONE")).ledger;
  ledger = go(ledger, judge("FAIL")).ledger;
  ledger = go(ledger, report("DONE")).ledger;
  ledger = go(ledger, judge("PASS")).ledger;
  const pass = go(ledger, judge("PASS"));
  assert.equal(pass.next, "gate");
  assert.equal(step(pass.ledger, { type: "gate", record: green() }).next, "close");
  const fail = go(ledger, judge("FAIL"));
  assert.equal(fail.next, "stop");
  assert.match(fail.reason, /final verifier/);
});

test("verify / recheck FAIL with fewer than 3 verdicts → fix, resuming the builder", () => {
  let ledger = go(lane(), report("DONE", ok, { agent: "builder-1" })).ledger;
  const first = go(ledger, judge("FAIL"));
  assert.equal(first.next, "fix");
  const fix = first.ledger.rounds.at(-1);
  const failed = first.ledger.rounds.at(-2).reportPath;
  assert.deepEqual(
    [fix.role, fix.mode, fix.agent, fix.from],
    ["build", "resume", "builder-1", failed],
  );
  assert.equal(fix.guard, undefined);
  assert.equal(first.ledger.state, "fixing");
  ledger = go(first.ledger, report("DONE")).ledger;
  assert.equal(go(ledger, judge("FAIL")).next, "fix", "recheck FAIL at verdict 2");
});

test("a FAIL at the 3rd verdict → stop, every verdict kept", () => {
  let ledger = go(lane(), report("DONE")).ledger;
  for (let i = 1; i < MAX_VERDICTS; i++) {
    ledger = go(ledger, judge("FAIL")).ledger;
    ledger = go(ledger, report("DONE")).ledger;
  }
  const res = go(ledger, judge("FAIL"));
  assert.equal(res.next, "stop");
  assert.match(res.reason, /FAIL at verdict 3/);
  assert.deepEqual(
    verdicts(res.ledger).map((r) => r.verdict),
    ["FAIL", "FAIL", "FAIL"],
  );
});

test("void verdicts do not count toward the 3", () => {
  let ledger = go(lane(), report("DONE")).ledger;
  ledger = go(ledger, judge("FAIL")).ledger;
  ledger = go(ledger, report("DONE")).ledger;
  ledger = go(ledger, judge("FAIL", MOVED), MOVED).ledger; // void: recheck
  assert.equal(go(ledger, judge("FAIL", MOVED)).next, "fix", "the 2nd real verdict, not the 3rd");
});

test("no `Verdict:` last line → resend once, then stop", () => {
  const toVerify = go(lane(), report("DONE")).ledger;
  const first = go(toVerify, judge(null, TIP, { agent: "v1" }));
  assert.equal(first.next, "resend");
  const round = first.ledger.rounds.at(-1);
  assert.deepEqual(
    [round.step, round.role, round.resend, round.agent],
    ["verify", "verify", true, "v1"],
  );
  const second = go(first.ledger, judge(null));
  assert.equal(second.next, "stop");
  // a resent verifier that answers goes on as its step would
  assert.equal(go(first.ledger, judge("PASS")).next, "gate");
});

test("an out-of-order event throws and names what the lane expects", () => {
  assert.throws(() => step(lane(), judge("PASS")), /expects report, not a verdict/);
  const toVerify = go(lane(), report("DONE")).ledger;
  assert.throws(() => step(toVerify, report("DONE")), /expects verdict, not a report/);
  const stopped = go(lane(), report("BLOCKED")).ledger;
  assert.equal(expects(stopped), null);
  assert.throws(() => step(stopped, report("DONE")), /expects nothing/);
});

test("the 3rd void verdict → stop: a branch that keeps moving under its verifiers ends the lane", () => {
  let ledger = go(lane(), report("DONE")).ledger;
  let res;
  for (const tip of ["c", "d", "e"].map((c) => c.repeat(40))) {
    res = go(ledger, judge("PASS", tip), tip);
    ledger = res.ledger;
  }
  assert.equal(res.next, "stop");
  assert.match(res.reason, /3 void verdicts/);
  assert.equal(ledger.rounds.filter((r) => r.void).length, 3);
});

test("the resend budget is the lane's: alternating causes can't reset it", () => {
  // verifier: no Verdict line → resend; a void recheck; no Verdict line again → stop
  let ledger = go(lane(), report("DONE")).ledger;
  ledger = go(ledger, judge(null)).ledger;
  assert.equal(ledger.next, "resend");
  ledger = go(ledger, judge("PASS", MOVED), MOVED).ledger;
  assert.equal(ledger.next, "recheck");
  const res = go(ledger, judge(null, MOVED));
  assert.equal(res.next, "stop");
  assert.match(res.reason, /sent back once/);

  // builder: no status → resend; NEEDS_CONTEXT; no status again → stop
  let built = go(lane(), report(null)).ledger;
  built = go(built, report("NEEDS_CONTEXT")).ledger;
  assert.equal(built.next, "needs-context");
  assert.equal(go(built, report(null)).next, "stop");
});

test("a guard fix that is sent back, then trips the guard again → stop", () => {
  const dirty = { dirty: [" M a"], commits: 1 };
  let ledger = go(lane(), report("DONE", dirty)).ledger;
  assert.equal(ledger.next, "fix");
  ledger = go(ledger, report(null)).ledger;
  assert.equal(ledger.next, "resend");
  const res = go(ledger, report("DONE", dirty));
  assert.equal(res.next, "stop");
  assert.match(res.reason, /again after a fix for it/);
});

// A seeded generator (mulberry32), so a failing walk can be replayed from its seed.
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Every event the lane could get next, at branch tip `tip` (a verdict may come with the tip moved).
function eventsFor(want, tip, n) {
  const moved = String(n).padEnd(40, "f");
  if (want === "report") {
    const guards = [ok, { dirty: [" M x"], commits: 1 }, { dirty: [], commits: 0 }];
    const statuses = ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED", null];
    return [
      ...statuses.flatMap((s) => guards.map((g) => ({ tip, event: report(s, g, { agent: "b" }) }))),
      { tip, event: report("DONE", { ...ok, mainTouched: "HEAD moved" }) },
    ];
  }
  if (want === "verdict")
    return ["PASS", "PASS WITH NOTES", "FAIL", null].flatMap((v) =>
      [tip, moved].flatMap((t) =>
        [true, false].map((gate) => ({ tip: t, event: judge(v, t, { agent: "v", gate }) })),
      ),
    );
  return [green(tip), { ...green(tip), exit: 1 }, green(MOVED)].map((record) => ({
    tip,
    event: { type: "gate", record },
  }));
}

test("no state loops: 300 adversarial walks of up to 200 events all stop or close", () => {
  // Each walk picks, at random, among the events that keep the lane open: if even that ends every
  // walk, no sequence of reports, verdicts and gates keeps a lane going forever.
  let longest = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const pick = random(seed);
    let tip = TIP;
    let ledger = lane();
    let events = 0;
    for (; events < 200; events++) {
      const want = expects(ledger);
      if (want === null || want === "close") break;
      const outcomes = eventsFor(want, tip, events).map((c) => ({
        ...c,
        ledger: go(ledger, c.event, c.tip).ledger,
      }));
      const open = outcomes.filter((o) => !["stop", "close"].includes(o.ledger.next));
      const pool = open.length ? open : outcomes;
      const chosen = pool[Math.floor(pick() * pool.length)];
      tip = chosen.tip;
      ledger = chosen.ledger;
    }
    assert.ok(
      ["stop", "close"].includes(ledger.next),
      `seed ${seed}: still at ${ledger.next} after ${events} events`,
    );
    longest = Math.max(longest, events);
  }
  assert.ok(longest <= 30, `the longest walk took ${longest} events`);
});

test("a red record naming flaky tests only records: the re-run's record decides", () => {
  const atGate = go(go(lane(), report("DONE")).ledger, judge("PASS")).ledger;
  const flakyRed = { ...green(), exit: 1, flakyRed: ["test_budget"] };
  const first = step(atGate, { type: "gate", record: flakyRed });
  assert.equal(first.next, "gate");
  assert.equal(first.ledger.state, "verifying");
  assert.equal(step(first.ledger, { type: "gate", record: green() }).next, "close");
  const again = step(first.ledger, { type: "gate", record: { ...green(), exit: 1 } });
  assert.equal(again.next, "stop");
  assert.deepEqual(again.ledger.gates.length, 2);
});

test("gateTally counts green and red runs on a tip and says so in one line", () => {
  const red = { ...green(), exit: 1 };
  const gates = [green(), red, { ...red, flakyRed: ["t"] }, green(MOVED)];
  assert.deepEqual(gateTally(gates, TIP), {
    green: 1,
    red: 2,
    flaky: 1,
    text: "1 green, then 2 red on this tip (1 red only in flaky tests): the latest is red",
  });
  assert.equal(
    gateTally([green(), red], TIP).text,
    "1 green, then 1 red on this tip: the latest is red",
  );
  assert.equal(gateTally([red, green()], TIP).text, "1 green, 1 red on this tip");
  assert.equal(gateTally([], TIP).text, null);
  assert.equal(gateTally([green(MOVED)], TIP).text, null);
});

// A lane verified with PASS WITH NOTES, the gate next.
function withNotes() {
  const ledger = go(lane(), report("DONE", ok, { agent: "builder-1" })).ledger;
  return go(ledger, judge("PASS WITH NOTES", TIP, { agent: "verifier-1" })).ledger;
}

test("notes after PASS WITH NOTES → fix (resume the builder), then the usual recheck", () => {
  const verified = withNotes();
  assert.equal(verified.next, "gate");
  const res = go(verified, { type: "notes", notes: ["N1", "N3"] });
  assert.equal(res.next, "fix");
  const round = res.ledger.rounds.at(-1);
  assert.deepEqual(
    [round.role, round.mode, round.agent, round.notes, round.from],
    ["build", "resume", "builder-1", ["N1", "N3"], verified.rounds.at(-1).reportPath],
  );
  assert.equal(res.ledger.state, "fixing");
  const rechecked = go(res.ledger, report("DONE"));
  assert.equal(rechecked.next, "recheck");
  assert.equal(rechecked.ledger.rounds.at(-1).agent, "verifier-1");
});

test("notes are refused unless the lane is verified PASS WITH NOTES, before it closes", () => {
  const refused = /notes can be fixed only after a PASS WITH NOTES verdict/;
  assert.throws(() => step(lane(), { type: "notes", notes: ["N1"] }), refused);
  const plain = go(go(lane(), report("DONE")).ledger, judge("PASS")).ledger;
  assert.throws(() => step(plain, { type: "notes", notes: ["N1"] }), refused);
  const closed = step(withNotes(), { type: "gate", record: green() }).ledger;
  assert.equal(closed.next, "close");
  assert.equal(step(closed, { type: "notes", notes: ["N1"] }).next, "fix");
  const merged = { ...closed, next: "merge" };
  assert.throws(() => step(merged, { type: "notes", notes: ["N1"] }), refused);
});

// ---- the owner sends a verified lane back (field 77) -----------------------------------------------

const owner = (note = "rename it") => ({ type: "owner", note, at: "t1" });

test("owner on a verified lane → fix (resume the last builder) with the change, recorded in ownerFixes", () => {
  const verified = go(go(lane(), report("DONE", ok, { agent: "builder-1" })).ledger, {
    ...judge("PASS", TIP, { agent: "verifier-1" }),
  }).ledger;
  const closed = step(verified, { type: "gate", record: green() }).ledger;
  for (const ready of [closed, { ...closed, next: "merge" }]) {
    const res = go(ready, owner());
    assert.equal(res.next, "fix");
    const round = res.ledger.rounds.at(-1);
    assert.deepEqual(
      [round.n, round.role, round.mode, round.agent, round.owner],
      [3, "build", "resume", "builder-1", { note: "rename it", at: "t1" }],
    );
    assert.deepEqual(res.ledger.ownerFixes, [{ note: "rename it", at: "t1", round: 3 }]);
    assert.equal(res.ledger.state, "fixing");
    // Its report goes as any fix's: the last verifier rechecks it.
    const rechecked = go(res.ledger, report("DONE"));
    assert.deepEqual(
      [rechecked.next, rechecked.ledger.rounds.at(-1).agent],
      ["recheck", "verifier-1"],
    );
  }
});

test("owner on a lane its route sent past the verifier → after the fix, the gate on the new tip", () => {
  const gated = go(lane(), report("DONE", ok, { skipVerify: true, gate: true, tip: TIP })).ledger;
  const closed = step(gated, { type: "gate", record: green() }).ledger;
  assert.equal(closed.next, "close");
  const sent = go(closed, owner()).ledger;
  const res = step(sent, report("DONE", ok, { skipVerify: true, gate: true, tip: MOVED }));
  assert.deepEqual([res.next, res.ledger.gateTip], ["gate", MOVED]);
  assert.deepEqual(
    step(res.ledger, { type: "gate", record: green(MOVED) }).ledger.closedTip,
    MOVED,
  );
});

test("owner is refused unless the lane is verified with close or merge next", () => {
  const refused = /the owner's fix is for a verified lane/;
  assert.throws(() => step(lane(), owner()), refused);
  const gateNext = go(go(lane(), report("DONE")).ledger, judge("PASS")).ledger;
  assert.equal(gateNext.next, "gate");
  assert.throws(() => step(gateNext, owner()), refused);
  assert.throws(() => step({ ...gateNext, state: "merged", next: null }, owner()), refused);
});

// ---- steps, runs and the owner's holds (fields 47, 48, 54) -------------------------------------------

const AT = "2026-11-03T10:00:00.000Z";
const LATER = "2026-11-03T11:00:00.000Z";
const step3 = (n, gate = null) => ({ n, text: `step ${n}`, gate, accept: [] });
// Steps `1 → owner OK, 2, 3`, or as given.
const GATED = [step3(1, "owner"), step3(2), step3(3)];
function stepped(steps = GATED) {
  const ledger = { v: 1, id: "T1", steps, rounds: [], gates: [], state: "building", next: "build" };
  return dispatch(ledger, begin(steps).dispatch);
}
// `step`, checking the input ledger is left as it was.
function pure(ledger, event, tip = TIP) {
  const copy = structuredClone(ledger);
  const res = go(ledger, event, tip);
  assert.deepEqual(ledger, copy, "the input ledger is unchanged");
  return res;
}
const done = (tip = TIP, extra = {}) =>
  report("DONE", ok, { tip, at: AT, agent: "builder-1", ...extra });
const resume = (extra = {}) => ({
  type: "resume",
  note: "OK, go",
  at: LATER,
  tip: MOVED,
  gate: true,
  ...extra,
});

test("start, the contract has steps → build (fresh) on the first run: steps 1..g", () => {
  const ledger = stepped();
  assert.deepEqual(ledger.rounds[0].stepRun, [1, 1]);
  assert.deepEqual(stepped([step3(1), step3(2, "owner"), step3(3)]).rounds[0].stepRun, [1, 2]);
  assert.deepEqual(stepped([step3(1), step3(2)]).rounds[0].stepRun, [1, 2]);
  assert.equal(lane().rounds[0].stepRun, undefined, "a lane without steps has no runs");
});

test("a run that ends at an owner gate holds the lane for the owner, the report as evidence", () => {
  const res = pure(stepped(), done());
  assert.equal(res.next, "resume");
  assert.equal(res.ledger.state, "held");
  assert.equal(res.dispatch, undefined);
  assert.equal(expects(res.ledger), "resume");
  assert.deepEqual(res.ledger.hold, {
    for: "owner",
    when: "after",
    stepRun: [1, 1],
    evidence: "/r",
    since: AT,
    round: 1,
  });
  assert.equal(res.reason, "the owner reviews step 1 of 3 before the lane goes on");
});

test("a run that ends at the last step goes on as a build does: verify, or the gate under exec.verify", () => {
  const plain = [step3(1), step3(2)];
  assert.equal(pure(stepped(plain), done()).next, "verify");
  const gated = pure(stepped(plain), done(TIP, { skipVerify: true, gate: true }));
  assert.equal(gated.next, "gate");
  assert.equal(gated.ledger.rounds[0].builtTip, TIP);
});

test("steps with no gate are one run: one build round, then verify", () => {
  const res = pure(stepped([step3(1), step3(2), step3(3)]), done());
  assert.deepEqual(
    res.ledger.rounds.map((r) => [r.step, r.stepRun]),
    [
      ["build", [1, 3]],
      ["verify", undefined],
    ],
  );
});

test("held: resume → continue (resume the builder) on the next run, its answer kept with its time", () => {
  const held = go(stepped(), done()).ledger;
  const res = pure(held, resume());
  assert.equal(res.next, "continue");
  assert.equal(res.ledger.state, "building");
  const round = res.ledger.rounds.at(-1);
  assert.deepEqual(
    [round.step, round.role, round.mode, round.agent, round.stepRun],
    ["continue", "build", "resume", "builder-1", [2, 3]],
  );
  assert.equal(res.ledger.hold, undefined);
  assert.deepEqual(res.ledger.holds, [
    {
      for: "owner",
      when: "after",
      stepRun: [1, 1],
      evidence: "/r",
      since: AT,
      resumedAt: LATER,
      note: "OK, go",
      redo: false,
    },
  ]);
});

test("runs [1,1] then [2,3] for steps 1 → owner OK, 2, 3; after the last step one verifier", () => {
  let ledger = go(stepped(), done()).ledger;
  ledger = go(ledger, resume(), TIP).ledger;
  const res = pure(ledger, done(MOVED));
  assert.equal(res.next, "verify");
  assert.deepEqual(
    res.ledger.rounds.map((r) => [r.step, r.stepRun ?? null]),
    [
      ["build", [1, 1]],
      ["continue", [2, 3]],
      ["verify", null],
    ],
  );
});

test("run a..g (a > 1): no commits since step a began → fix (resume) with the reason", () => {
  let ledger = go(stepped(), done()).ledger;
  ledger = go(ledger, resume(), TIP).ledger; // step 2 dispatched on TIP
  const res = pure(ledger, done(TIP));
  assert.equal(res.next, "fix");
  const round = res.ledger.rounds.at(-1);
  assert.deepEqual([round.guard, round.stepRun], [true, [2, 3]]);
  assert.match(round.reason, /no commits since step 2 began/);
  const again = go(res.ledger, done(TIP));
  assert.equal(again.next, "stop");
});

test("held: resume with redo → continue on the same run, and the lane holds again at its end", () => {
  const held = go(stepped(), done()).ledger;
  const res = pure(held, resume({ redo: true }), TIP);
  const round = res.ledger.rounds.at(-1);
  assert.deepEqual([res.next, round.stepRun, round.redo], ["continue", [1, 1], true]);
  assert.equal(res.ledger.holds[0].redo, true);
  // Sent back, even step 1 must come back with a commit made since the redo was dispatched.
  assert.match(pure(res.ledger, done(TIP)).reason, /no commits since step 1 began/);
  const again = pure(res.ledger, done(MOVED));
  assert.equal(again.next, "resume");
  assert.equal(again.ledger.hold.when, "after");
});

test("a redo of a run past step 1 needs a commit since the redo began", () => {
  const CUT = "c".repeat(40);
  const steps = [step3(1, "owner"), step3(2, "owner"), step3(3)];
  let ledger = go(stepped(steps), done()).ledger;
  ledger = go(ledger, resume(), TIP).ledger; // step 2 on TIP
  ledger = go(ledger, done(MOVED)).ledger; // held after step 2
  ledger = go(ledger, resume({ redo: true }), MOVED).ledger; // step 2 again, from MOVED
  assert.match(pure(ledger, done(MOVED)).reason, /no commits since step 2 began/);
  assert.equal(pure(ledger, done(CUT)).next, "resume");
});

test("redo is refused on a hold during a round, which a resume carries on", () => {
  const during = go(stepped(), { type: "hold", for: "owner", evidence: "/e", at: AT }).ledger;
  assert.throws(() => step(during, resume({ redo: true })), /--redo goes back over a finished run/);
});

test("held after the last step: resume → verify (fresh), or the gate under exec.verify", () => {
  const steps = [step3(1), step3(2, "owner")];
  const held = go(stepped(steps), done()).ledger;
  assert.equal(held.hold.when, "after");
  const verify = pure(held, resume());
  assert.equal(verify.next, "verify");
  assert.equal(verify.ledger.rounds.at(-1).mode, "fresh");
  const gated = pure(held, resume({ skipVerify: true }));
  assert.equal(gated.next, "gate");
  assert.equal(gated.ledger.rounds.at(-1).builtTip, MOVED);
});

test("{ type: hold } while a builder's round is out → held during it; the round is left unread", () => {
  const res = pure(lane(), { type: "hold", for: "owner", evidence: "/e", at: AT });
  assert.deepEqual([res.next, res.ledger.state], ["resume", "held"]);
  assert.deepEqual(res.ledger.hold, {
    for: "owner",
    when: "during",
    stepRun: null,
    evidence: "/e",
    since: AT,
    round: 1,
  });
  assert.equal(res.ledger.rounds[0].held, true);
  assert.equal(res.ledger.rounds[0].report, undefined);
  const parked = step(res.ledger, {
    type: "hold",
    for: "later",
    evidence: null,
    at: LATER,
    why: "stopped",
    agent: "builder-7",
  });
  assert.deepEqual(
    [parked.ledger.hold.for, parked.ledger.hold.since, parked.ledger.hold.why],
    ["later", AT, "stopped"],
  );
  assert.equal(parked.ledger.rounds[0].agent, "builder-7", "the hold names the round's builder");
  const owner = step(parked.ledger, { type: "hold", for: "owner", evidence: "/e", at: LATER });
  assert.equal(owner.ledger.hold.why, undefined, "a new hold drops the old reason");
  assert.equal(step(owner.ledger, resume()).ledger.rounds.at(-1).agent, "builder-7");
  assert.throws(
    () => step(go(lane(), report("DONE")).ledger, { type: "hold", for: "owner", at: AT }),
    /hold is for a builder's round: the lane is verifying \(next verify\)/,
  );
});

test("a hold during a fix round after a FAIL → continue → recheck", () => {
  let ledger = go(stepped([step3(1)]), done()).ledger;
  ledger = go(ledger, judge("FAIL", TIP, { agent: "verifier-1" })).ledger;
  assert.equal(ledger.next, "fix");
  ledger = pure(ledger, { type: "hold", for: "owner", evidence: "/e", at: AT }).ledger;
  assert.equal(ledger.hold.stepRun, null);
  const res = pure(ledger, resume());
  assert.equal(res.next, "continue");
  assert.equal(res.ledger.rounds.at(-1).stepRun, undefined);
  const rechecked = pure(res.ledger, done(MOVED));
  assert.equal(rechecked.next, "recheck");
  assert.equal(rechecked.ledger.rounds.at(-1).agent, "verifier-1");
});

test("held: report, verdict and notes are refused; a gate is recorded and decides nothing", () => {
  const held = go(stepped(), done()).ledger;
  for (const event of [done(), judge("PASS"), { type: "notes", notes: ["N1"] }])
    assert.throws(() => step(held, event), /the lane is held: it expects a resume/);
  const gated = step(held, { type: "gate", record: green() });
  assert.deepEqual(
    [gated.next, gated.ledger.state, gated.ledger.gates.length],
    ["resume", "held", 1],
  );
  assert.throws(
    () => step(lane(), resume()),
    /the lane is not held \(state building, next build\)/,
  );
});

test("a round sent back inside a run (a resend) builds the same run", () => {
  const res = pure(stepped(), report(null, ok, { at: AT }));
  assert.equal(res.next, "resend");
  assert.deepEqual(res.ledger.rounds.at(-1).stepRun, [1, 1]);
});

// ---- presets: the final, the notes rounds, the rebase and the resolution recheck (A47, A48) ----------

// A lane whose route is `route` (the ledger's snapshot from start), its first build round dispatched.
const routed = (route) => ({ ...lane(), route: { verify: "all", flagged: false, ...route } });
// A lane rechecking after a FAIL: build, FAIL, fix, the recheck out on TIP.
function rechecking(route) {
  let { ledger } = go(routed(route), report("DONE", ok, { agent: "builder-1" }));
  ({ ledger } = go(ledger, judge("FAIL", TIP, { agent: "verifier-1" })));
  ({ ledger } = go(ledger, report("DONE")));
  assert.equal(ledger.rounds.at(-1).step, "recheck");
  return ledger;
}
const covering = { covered: true, onlyFixCommits: true };

test("recheck PASS under final always → final (today's row)", () => {
  const res = go(rechecking({ final: "always" }), judge("PASS", TIP, covering));
  assert.equal(res.next, "final");
  assert.match(res.reason, /exec\.final is "always"/);
});

test("recheck PASS under final never → gate, or close when green on this tip", () => {
  const res = go(rechecking({ final: "never" }), judge("PASS WITH NOTES"));
  assert.equal(res.next, "gate");
  assert.equal(res.ledger.gateTip, TIP);
  const green1 = { ...rechecking({ final: "never" }), gates: [green()] };
  const closed = go(green1, judge("PASS", TIP, { tier: "full" }));
  assert.equal(closed.next, "close");
  assert.equal(closed.ledger.closedTip, TIP);
});

test("recheck PASS under after-fix, covering every note on a fix-only tip → gate / close, no final", () => {
  const res = go(rechecking({ final: "after-fix" }), judge("PASS", TIP, covering));
  assert.equal(res.next, "gate");
  const round = res.ledger.rounds.at(-1);
  assert.deepEqual([round.covered, round.onlyFixCommits], [true, true], "the facts are pinned");
});

test("recheck PASS under after-fix with a label missing → final", () => {
  const res = go(
    rechecking({ final: "after-fix" }),
    judge("PASS", TIP, { covered: false, onlyFixCommits: true }),
  );
  assert.equal(res.next, "final");
  assert.match(res.reason, /did not pass every note sent back/);
});

test("recheck PASS under after-fix on a rewritten tip, or one with a merge commit since → final", () => {
  // Both are `onlyFixCommits: false` to the machine: exec computes the fact from git.
  for (const why of ["a rewritten tip", "a merge commit in the range"]) {
    const res = go(
      rechecking({ final: "after-fix" }),
      judge("PASS", TIP, { covered: true, onlyFixCommits: false }),
    );
    assert.equal(res.next, "final", why);
    assert.match(res.reason, /more than fix commits/, why);
  }
});

test("a ledger whose route has only verify and flagged runs on the standard values", () => {
  const ledger = rechecking({});
  const old = { ...ledger, route: { verify: "all", flagged: false } };
  assert.equal(go(old, judge("PASS", TIP, covering)).next, "gate", "after-fix: no final");
  assert.equal(go(old, judge("PASS")).next, "final", "after-fix: no facts → final");
  assert.equal(notesBudget(old).max, 1);
  const none = lane(); // no route at all
  assert.equal(notesBudget(none).max, 1);
});

// A lane verified PASS WITH NOTES (gate next) on `route`, after `rounds` notes rounds.
function noted(route, rounds = 0) {
  let { ledger } = go(routed(route), report("DONE", ok, { agent: "builder-1" }));
  ({ ledger } = go(ledger, judge("PASS WITH NOTES", TIP, { agent: "verifier-1" })));
  for (let i = 0; i < rounds; i++) {
    ({ ledger } = go(ledger, { type: "notes", notes: ["N1"] }));
    ({ ledger } = go(ledger, report("DONE")));
    ({ ledger } = go(ledger, judge("PASS WITH NOTES", TIP, covering)));
  }
  return ledger;
}

test("verified PASS WITH NOTES, rounds used < noteRounds → fix → recheck", () => {
  const res = go(noted({ noteRounds: 1 }), { type: "notes", notes: ["N2"] });
  assert.equal(res.next, "fix");
  assert.equal(go(res.ledger, report("DONE")).next, "recheck");
});

test("verified PASS WITH NOTES at the budget: a notes round is refused naming exec.noteRounds", () => {
  for (const [route, rounds] of [
    [{ noteRounds: 0 }, 0],
    [{ noteRounds: 1 }, 1],
  ]) {
    const ledger = noted({ ...route, final: "never" }, rounds);
    assert.equal(ledger.next, "gate", "the lane goes on to the gate");
    assert.throws(
      () => step(ledger, { type: "notes", notes: ["N1"] }),
      new RegExp(
        `${rounds} of ${route.noteRounds} notes rounds are used \\(exec\\.noteRounds is ${route.noteRounds}\\)`,
      ),
    );
  }
});

// A lane closed on a green gate, verified PASS by a verifier (or none: `verified: false`).
function closedLane(route = {}, { verified = true } = {}) {
  let ledger = routed(route);
  if (verified) {
    ({ ledger } = go(ledger, report("DONE", ok, { agent: "builder-1" })));
    ({ ledger } = go(ledger, judge("PASS")));
  } else {
    ({ ledger } = go(
      ledger,
      report("DONE", ok, { agent: "builder-1", skipVerify: true, tip: TIP }),
    ));
  }
  ({ ledger } = go(ledger, { type: "gate", record: green() }));
  assert.equal(ledger.next, "close");
  assert.equal(ledger.closedTip, TIP);
  return ledger;
}

test("verified { type: rebase } → rebase (role build, resuming the last builder)", () => {
  for (const next of ["close", "merge"]) {
    const res = go({ ...closedLane(), next }, { type: "rebase" });
    assert.equal(res.next, "rebase");
    const round = res.ledger.rounds.at(-1);
    assert.deepEqual([round.role, round.mode, round.agent], ["build", "resume", "builder-1"]);
    assert.equal(res.ledger.state, "building");
    assert.equal(expects(res.ledger), "report");
  }
  assert.throws(() => step(lane(), { type: "rebase" }), /a rebase is for a verified lane/);
});

// A closed lane with its rebase round out.
const rebasing = (route) => go(closedLane(route), { type: "rebase" }).ledger;

test("rebase DONE, guards hold, changed, rebase recheck → resolve (role verify, fresh)", () => {
  const res = go(
    rebasing({ rebase: "recheck" }),
    report("DONE", ok, { tip: MOVED, changed: true }),
    MOVED,
  );
  assert.equal(res.next, "resolve");
  const round = res.ledger.rounds.at(-1);
  assert.deepEqual([round.role, round.mode, round.step], ["verify", "fresh", "resolve"]);
});

test("rebase DONE, guards hold, otherwise → gate on the new tip, or close when green on it", () => {
  const clean = go(
    rebasing({ rebase: "recheck" }),
    report("DONE", ok, { tip: MOVED, changed: false }),
  );
  assert.equal(clean.next, "gate");
  assert.equal(clean.ledger.gateTip, MOVED);
  assert.equal(step(clean.ledger, { type: "gate", record: green(MOVED) }).next, "close");
  assert.equal(step(clean.ledger, { type: "gate", record: green(MOVED) }).ledger.closedTip, MOVED);
  const gated = go(rebasing({ rebase: "gate" }), report("DONE", ok, { tip: MOVED, changed: true }));
  assert.equal(gated.next, "gate");
  assert.match(gated.reason, /exec\.rebase is "gate"/);
  const green2 = { ...rebasing({ rebase: "gate" }), gates: [green(MOVED)] };
  const closed = go(green2, report("DONE", ok, { tip: MOVED, changed: false, tier: "full" }));
  assert.equal(closed.next, "close");
  assert.equal(closed.ledger.closedTip, MOVED);
});

test("rebase: a guard trip sends the rebase back once, then stops; NEEDS_CONTEXT stops", () => {
  const dirty = { dirty: ["x.txt"], commits: 1 };
  const once = go(rebasing(), report("DONE", dirty));
  assert.equal(once.next, "rebase");
  assert.equal(once.ledger.rounds.at(-1).guard, true);
  assert.equal(go(once.ledger, report("DONE", dirty)).next, "stop");
  const asked = go(rebasing(), report("NEEDS_CONTEXT"));
  assert.equal(asked.next, "stop");
  assert.match(asked.reason, /NEEDS_CONTEXT on the rebase/);
});

test("verified, branch already moved: { type: rebased } goes as the rebase report rows", () => {
  const changed = go(
    closedLane({ rebase: "recheck" }),
    { type: "rebased", tip: MOVED, changed: true },
    MOVED,
  );
  assert.equal(changed.next, "resolve");
  const clean = step(closedLane(), { type: "rebased", tip: MOVED, changed: false });
  assert.deepEqual([clean.next, clean.ledger.gateTip], ["gate", MOVED]);
  assert.throws(
    () => step(lane(), { type: "rebased", tip: MOVED }),
    /rebased is for a verified lane/,
  );
});

// A lane with its resolve round out, dispatched on MOVED.
const resolving = () =>
  go(rebasing({ rebase: "recheck" }), report("DONE", ok, { tip: MOVED, changed: true }), MOVED)
    .ledger;

test("resolve PASS* → gate / close; FAIL → stop naming the resolution", () => {
  for (const verdict of ["PASS", "PASS WITH NOTES"]) {
    const res = go(resolving(), judge(verdict, MOVED));
    assert.deepEqual([res.next, res.ledger.gateTip], ["gate", MOVED], verdict);
  }
  const green3 = { ...resolving(), gates: [green(MOVED)] };
  assert.equal(go(green3, judge("PASS", MOVED)).next, "close");
  const fail = go(resolving(), judge("FAIL", MOVED));
  assert.equal(fail.next, "stop");
  assert.equal(fail.reason, "the conflict resolution failed its check");
});

test("resolve on a moved tip: void, resolve again; the third void stops the lane", () => {
  let ledger = resolving();
  const voids = ledger.rounds.filter((r) => r.void).length;
  for (let i = voids; i < 2; i++) {
    const res = go(ledger, judge("PASS", TIP), MOVED);
    assert.equal(res.next, "resolve");
    assert.deepEqual(
      [res.ledger.rounds.at(-1).step, res.ledger.rounds.at(-1).mode],
      ["resolve", "fresh"],
    );
    assert.equal(res.ledger.rounds.at(-2).void, true);
    ledger = res.ledger;
  }
  const third = go(ledger, judge("PASS", TIP));
  assert.equal(third.next, "stop");
  assert.match(third.reason, /3 void verdicts/);
});

test("a resolve verdict opens no notes round", () => {
  const ledger = go(resolving(), judge("PASS WITH NOTES", MOVED)).ledger;
  assert.throws(() => step(ledger, { type: "notes", notes: ["N1"] }), /notes can be fixed only/);
});

test("reverify on a lane closed without a verifier → verify (fresh); refused once a verifier closed it", () => {
  const res = go(closedLane({ verify: "flagged" }, { verified: false }), { type: "reverify" });
  assert.equal(res.next, "verify");
  assert.deepEqual([res.ledger.rounds.at(-1).mode, res.ledger.state], ["fresh", "verifying"]);
  assert.equal(go(res.ledger, judge("PASS")).next, "close", "green on this tip already: closes");
  assert.throws(() => step(closedLane(), { type: "reverify" }), /a verifier closed this one/);
  assert.throws(() => step(lane(), { type: "reverify" }), /reverify is for a verified lane/);
});

test("greenOn judges the newest record of the tier: a red after a green is not green", () => {
  const red = { ...green(), exit: 1 };
  assert.equal(greenOn([green(), red], TIP), false);
  assert.equal(greenOn([red, green()], TIP), true);
  assert.equal(greenOn([green(), { ...red, tier: "docs" }], TIP, "full"), true);
  assert.equal(greenOn([green(), { ...red, tier: "docs" }], TIP), false);
  assert.equal(greenOn([green(MOVED)], TIP), false);
});

test("a commit git could not read is named as a read failure, never as a subject to reword", () => {
  const failed = [
    {
      sha: `${TIP.slice(0, 7)}..${MOVED.slice(0, 7)}`,
      subject: "",
      why: "git rev-list failed: bad",
      failed: true,
    },
  ];
  const res = go(lane(), report("DONE", { ...ok, subjects: failed }));
  assert.equal(res.next, "fix");
  assert.equal(
    res.reason,
    `cannot read commit ${failed[0].sha}: git rev-list failed: bad → check the branch, then report again`,
  );
  assert.doesNotMatch(res.reason, /reword/);
});

test("every lane still ends with the new rows: rebase, resolve and notes walks stop or close", () => {
  // The budgets are the lane's as before: a resolve that keeps voiding stops at three, a notes budget
  // refuses the next round, and a rebase guard that trips twice stops.
  assert.equal(
    go(go(resolving(), judge("FAIL", MOVED)).ledger, { type: "gate", record: green() }).next,
    "stop",
  );
  const ledger = noted({ noteRounds: 3, final: "never" }, 3);
  assert.throws(() => step(ledger, { type: "notes", notes: ["N1"] }), /3 of 3/);
});
