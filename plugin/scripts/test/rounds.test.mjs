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
    text: "1 green, 2 red on this tip (1 red only in flaky tests)",
  });
  assert.equal(gateTally([green(), red], TIP).text, "1 green, 1 red on this tip");
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
