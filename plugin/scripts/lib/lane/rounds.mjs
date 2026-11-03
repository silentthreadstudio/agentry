// rounds — the exec round machine (plan R1b §3.2, pinned). PURE: no I/O, no clock; the caller hands in
// every fact (the report's status, the guards it measured, the branch tip, the gate record) and gets back
// a new ledger (the input is never changed) and the next step.
//
//   start                                   → build (fresh)
//   build / fix: DONE or DONE_WITH_CONCERNS → verify (fresh) when no verdict yet, else recheck (resume)
//   build / fix: DONE, and the report says to skip the verifier (exec.verify) and a gate is configured
//                                           → gate (green on this tip) → close: the gate stands in for the verifier
//   build / fix: main touched (any status)  → stop
//   build / fix: uncommitted files, no commits past base, or a commit that breaks the workflow file's
//                `commits` rules                    → fix (resume) with the reason; twice → stop
//   build / fix: NEEDS_CONTEXT              → needs-context (resume) once, then stop
//   build / fix: BLOCKED                    → stop; no status line → resend once, then stop
//   verify / recheck / final: tip moved     → recheck: the verdict is void (no rebase while one reads);
//                                             the 3rd void verdict → stop
//   verify: PASS*                           → gate (no green worktree gate on this tip), then close
//   recheck: PASS*                          → final (fresh, against the full bar)
//   final: PASS* / FAIL                     → gate → close / stop
//   verify / recheck: FAIL                  → fix (resume the builder); at the 3rd verdict → stop
//   no `Verdict:` last line                 → resend once, then stop
//   verified PASS WITH NOTES (gate or close next): { type: "notes" } → fix (resume the builder) on the named
//                                             notes, then the usual recheck
//   gate: red only in listed flaky tests    → no decision: the alone re-run's record decides
//   start, the contract has steps            → build (fresh) on the first run: steps 1..g, g the first step
//                                             ending "→ owner OK", else the last step
//   build / fix / continue on run a..g, no verdict yet: DONE or DONE_WITH_CONCERNS, guards hold
//                                           → hold (held) when step g ends "→ owner OK"; else g is the last
//                                             step: as build above (verify, or the gate under exec.verify)
//   build / fix / continue on run a..g (a > 1): no commits since step a began → fix (resume) with the reason
//                                             (a run the owner sent back with redo, from its own dispatch)
//   { type: "hold" } while a builder's round is out → hold (held); the round is left unread
//   held: { type: "resume", note }           → continue (resume the builder) on the next run; on the same run
//                                             after a "during" hold or with redo; after the last step → verify
//                                             (fresh), or the gate under exec.verify
//   held: report / verdict / notes           → refused: the lane expects a resume; a gate is recorded, decides nothing
//
// Every budget is the lane's, so no mix of outcomes resets one: one resend per role, one needs-context
// round, three counted verdicts (a final after a recheck PASS is the one more), three void ones, and a
// guard fix (resent or not) that trips a guard again stops. So every lane ends. A hold waits for the
// owner, who ends it with a resume; the owner's answers spend no budget.
//
// A round in the ledger: { n, step, role, mode, final?, resend?, guard?, agent?, from?, reason?,
// stepRun?, redo?, brief, reportPath, tip, at } plus, once reported, { report, status | verdict, void?,
// summary?, guards? }, or `held: true` when the lane was held before its report was read. A held lane
// has `hold: { for, when, stepRun, evidence, since, round, why? }`; each resume appends its answer to
// `holds[]`: { for, when, stepRun, evidence, since, resumedAt, note, redo, why? }.
import { runOf, runText } from "../process/steps.mjs";

export const MAX_VERDICTS = 3;
export const MAX_VOIDS = 3;
export const PASSES = ["PASS", "PASS WITH NOTES"];

// What each dispatch step sends: the agent's role and whether it resumes the agent of an earlier round.
const STEPS = {
  build: { role: "build", mode: "fresh" },
  fix: { role: "build", mode: "resume" },
  "needs-context": { role: "build", mode: "resume" },
  continue: { role: "build", mode: "resume" },
  verify: { role: "verify", mode: "fresh" },
  recheck: { role: "verify", mode: "resume" },
  final: { role: "verify", mode: "fresh", final: true },
};
export const DISPATCHES = [...Object.keys(STEPS), "resend"];

// The ledger state while each step is next.
const STATE = {
  build: "building",
  "needs-context": "building",
  continue: "building",
  fix: "fixing",
  verify: "verifying",
  recheck: "verifying",
  final: "verifying",
  gate: "verifying",
  close: "verified",
  resume: "held",
  stop: "stopped",
};

const last = (ledger) => ledger.rounds.at(-1);
const builders = (ledger) => ledger.rounds.filter((r) => r.role === "build");
const verifiers = (ledger) => ledger.rounds.filter((r) => r.role === "verify");
/** The verdicts that count: every verify round that gave one and was not voided. */
export const verdicts = (ledger) =>
  verifiers(ledger).filter((r) => typeof r.verdict === "string" && !r.void);

/** What the lane waits for: "report" (a builder's), "verdict" (a verifier's), "gate", "close", "resume"
 *  (the owner's answer to a hold), or null when nothing is dispatched or due (stopped, or already closed). */
export function expects(ledger) {
  if (ledger.state === "stopped") return null;
  if (ledger.state === "held") return "resume";
  if (ledger.next === "gate" || ledger.next === "close") return ledger.next;
  const round = last(ledger);
  if (!round || round.report !== undefined) return null;
  return round.role === "build" ? "report" : "verdict";
}

/** A green worktree gate record for commit `tip`: exit 0 on a tree clean before and after. */
export const greenOn = (gates, tip) =>
  (gates ?? []).some(
    (g) =>
      g.where === "worktree" &&
      g.exit === 0 &&
      g.cleanBefore === true &&
      g.cleanAfter === true &&
      g.commit === tip,
  );

/** Does `route` (the ledger's `{ verify, flagged }`, absent on an older ledger) send a built item straight
 *  to the gate? Only when verification is off for it: `flagged` and `none` skip every item that is not
 *  flagged; a flagged item always has a verifier. */
export const skipsVerifier = (route, flagged = false) =>
  ["flagged", "none"].includes(route?.verify) && !flagged && !route?.flagged;

/** The worktree gates recorded for commit `tip`, counted: `{ green, red, flaky }`. `flaky` is the part of
 *  `red` that failed only in tests the workflow file lists as flaky (and was re-run). `text` is the one
 *  line the verdict shows ("1 green, 1 red on this tip"), or null when there is no gate on this tip. */
export function gateTally(gates, tip) {
  const here = (gates ?? []).filter((g) => g.where === "worktree" && g.commit === tip);
  const green = here.filter((g) => g.exit === 0).length;
  const red = here.length - green;
  const flaky = here.filter((g) => g.exit !== 0 && g.flakyRed?.length).length;
  // A green does not outlive a red run after it: the line says which came last.
  const stale = green > 0 && here.at(-1)?.exit !== 0;
  const text =
    here.length === 0
      ? null
      : `${green} green, ${stale ? "then " : ""}${red} red on this tip${flaky ? ` (${flaky} red only in flaky tests)` : ""}${stale ? ": the latest is red" : ""}`;
  return { green, red, flaky, text };
}

/** The plan for the first round of a new lane; a contract with `steps` builds its first run. */
export const begin = (steps = []) => ({
  next: "build",
  dispatch: { step: "build", ...STEPS.build, ...(steps.length && { stepRun: runOf(steps, 1) }) },
});

/** Append the round `dispatch` describes (from `begin` or `step`), with its files and the branch tip at
 *  dispatch; the ledger's `next` and `state` follow it. */
export function addRound(ledger, dispatch, { brief, reportPath, tip, at }) {
  const out = structuredClone(ledger);
  const n = out.rounds.length + 1;
  out.rounds.push({ n, ...dispatch, brief, reportPath, tip, at });
  out.next = dispatch.resend ? "resend" : dispatch.step;
  out.state = STATE[dispatch.step];
  return out;
}

const stop = (ledger, reason) => {
  ledger.next = "stop";
  ledger.state = STATE.stop;
  ledger.stopReason = reason;
  return { ledger, next: "stop", reason };
};
const settle = (ledger, next, reason) => {
  ledger.next = next;
  ledger.state = STATE[next];
  return { ledger, next, reason };
};
const send = (ledger, step, extra, reason) => ({
  ledger,
  next: extra.resend ? "resend" : step,
  reason,
  dispatch: { step, ...STEPS[step], ...extra, ...(reason && { reason }) },
});
// The same round's step sent back to the same agent, once per role in the lane. A guard fix stays one
// when resent, so the guard tripping again still stops.
const resend = (ledger, round, reason) =>
  ledger.rounds.some((r) => r.resend && r.role === round.role)
    ? stop(ledger, `${reason}, after a ${round.role} report was sent back once`)
    : send(
        ledger,
        round.step,
        {
          mode: "resume",
          resend: true,
          from: round.reportPath,
          agent: round.agent,
          ...(round.guard && { guard: true }),
        },
        reason,
      );

/**
 * Step the machine with one event. Returns { ledger, next, reason?, dispatch? } where `dispatch` is the
 * round to send next (pass it to `addRound` with the brief rendered for it). Throws on an event the
 * ledger does not expect (out of order).
 *
 *   { type: "report", status, report, agent?, summary?, guards: { mainTouched?, dirty?, commits?, subjects?: [{ sha, subject, why }] },
 *     skipVerify?: true (exec.verify routes this item past the verifier), tip, gate: true | false, at }
 *   { type: "verdict", verdict, report, agent?, summary?, tip, gate: true | false (one configured) }
 *   { type: "gate", record }   (recorded at any time; decides only when the gate is the next step)
 *   { type: "notes", notes }   (a verified PASS WITH NOTES lane back to its builder)
 *   { type: "hold", for: "owner" | "later", evidence, at, why?, agent? }
 *   { type: "resume", note, redo?, at, skipVerify?, tip, gate }
 */
export function step(ledger, event) {
  const out = structuredClone(ledger);
  out.gates ??= [];
  if (event.type === "gate") return onGate(out, event.record);
  if (out.state === "held" && !["hold", "resume"].includes(event.type))
    throw new Error(`the lane is held: it expects a resume, not a ${event.type}`);
  if (event.type === "notes") return onNotes(out, event.notes);
  if (event.type === "hold") return onHold(out, event);
  if (event.type === "resume") return onResume(out, event);
  const want = expects(out);
  if (want !== event.type)
    throw new Error(`the lane expects ${want ?? "nothing"}, not a ${event.type}`);
  const round = last(out);
  round.report = event.report;
  if (event.agent) round.agent = event.agent;
  if (event.summary) round.summary = event.summary;
  return inRun(
    out,
    event.type === "report" ? onReport(out, round, event) : onVerdict(out, round, event),
  );
}

// Every builder round before the first verdict builds a run of the steps: a round sent back to the
// builder (a guard fix, a resend, a needs-context) builds the run its last builder round built.
function inRun(ledger, res) {
  const d = res.dispatch;
  if (d?.role !== "build" || d.stepRun || !ledger.steps?.length || verdicts(ledger).length)
    return res;
  const run = builders(ledger).at(-1)?.stepRun;
  return run ? { ...res, dispatch: { ...d, stepRun: run } } : res;
}

// One trip line per commit that breaks a `commits` rule, at most SUBJECT_TRIPS, then how many more.
const SUBJECT_TRIPS = 5;
function subjectTrips(broken = []) {
  const lines = broken
    .slice(0, SUBJECT_TRIPS)
    .map(
      (c) =>
        `commit ${short(c.sha)} "${c.subject}": ${c.why} → reword it on the branch (git commit --amend for the tip, or a rebase with exec, no -i)`,
    );
  if (broken.length > SUBJECT_TRIPS) lines.push(`+${broken.length - SUBJECT_TRIPS}`);
  return lines;
}

const sameRun = (a, b) => a?.[0] === b?.[0] && a?.[1] === b?.[1];

// The round the run `round` builds began with: the first builder round of that run since the owner's
// last answer that sent it back (a redo), else since the run was first dispatched.
function runStart(ledger, round) {
  let start = round;
  for (const r of builders(ledger).toReversed()) {
    if (r.n > round.n) continue;
    if (!sameRun(r.stepRun, round.stepRun)) break;
    start = r;
    if (r.redo) break;
  }
  return start;
}

function onReport(ledger, round, event) {
  const { status, guards = {}, tip } = event;
  round.status = status;
  // A builder that changed the main checkout stops the lane whatever it reports.
  if (guards.mainTouched) {
    round.guards = [`main touched: ${guards.mainTouched}`];
    return stop(ledger, round.guards[0]);
  }
  if (!status) return resend(ledger, round, "the report has no status line");
  if (status === "BLOCKED") return stop(ledger, "the builder reported BLOCKED");
  if (status === "NEEDS_CONTEXT") {
    if (builders(ledger).some((r) => r.step === "needs-context"))
      return stop(ledger, "NEEDS_CONTEXT again after the one re-dispatch with a supplied fact");
    return send(
      ledger,
      "needs-context",
      { from: round.reportPath, agent: round.agent },
      "the builder needs a fact",
    );
  }
  const trips = [];
  if (guards.dirty?.length)
    trips.push(`uncommitted files in the worktree: ${guards.dirty.slice(0, 10).join(", ")}`);
  if (guards.commits === 0) trips.push("no commits past base");
  trips.push(...subjectTrips(guards.subjects));
  // A run past step 1, or one the owner sent back (any run), must add a commit since it began.
  const from = round.stepRun?.[0];
  const begun = from && !verdicts(ledger).length ? runStart(ledger, round) : null;
  if (begun && (from > 1 || begun.redo) && tip !== undefined && begun.tip === tip)
    trips.push(`no commits since step ${from} began`);
  if (trips.length) {
    round.guards = trips;
    if (round.guard) return stop(ledger, `${trips.join("; ")}, again after a fix for it`);
    return send(
      ledger,
      "fix",
      { guard: true, from: round.reportPath, agent: round.agent },
      trips.join("; "),
    );
  }
  return verdicts(ledger).length
    ? routeBuilt(ledger, round, event)
    : afterRun(ledger, round, event);
}

// The end of a run (a builder's report, guards holding, no verdict yet): the lane holds for the owner
// when the run's last step has an owner gate, else the work is routed as built. The seam presets extend.
function afterRun(ledger, round, event) {
  const run = round.stepRun;
  const gated = run && ledger.steps?.[run[1] - 1]?.gate === "owner";
  if (!gated) return routeBuilt(ledger, round, event);
  const entry = {
    for: "owner",
    when: "after",
    stepRun: run,
    evidence: round.report ?? round.reportPath,
    since: event.at,
    round: round.n,
  };
  return hold(
    ledger,
    entry,
    `the owner reviews ${runText(run, ledger.steps.length)} before the lane goes on`,
  );
}

// Where built work goes, after a report or the owner's last answer: a fresh verifier when there is no
// verdict yet (or, when exec.verify skips the verifier and a gate is configured, the gate), else the
// last verifier resumed to recheck.
function routeBuilt(ledger, round, { skipVerify = false, tip, gate = true }) {
  if (verdicts(ledger).length === 0) {
    // Skipping the verifier needs a gate to stand in for it: with none, nothing would check the work.
    if (!skipVerify || !gate) return send(ledger, "verify", {});
    round.builtTip = tip;
    if (greenOn(ledger.gates, tip))
      return settle(ledger, "close", "a green worktree gate on this tip");
    return settle(ledger, "gate", "no verifier for this item: the gate decides");
  }
  const verifier = verdicts(ledger).at(-1);
  return send(ledger, "recheck", { from: verifier.reportPath, agent: verifier.agent }, null);
}

const hold = (ledger, entry, reason) => {
  ledger.hold = entry;
  return settle(ledger, "resume", reason);
};

// The owner looks at a builder's round that is out (`for: "owner"`), or the conductor parks a lane whose
// builder was stopped (`for: "later"`): the round is left unread. A held lane takes the new `for` and
// evidence and keeps its `since`.
function onHold(ledger, { for: who, evidence = null, at, why, agent }) {
  // `agent`: the builder out on the round, so the resume can send `continue` to it.
  if (agent) ledger.rounds[(ledger.hold?.round ?? ledger.rounds.length) - 1].agent = agent;
  if (ledger.state === "held") {
    // A new hold says its own why: the reason of the old one does not carry over.
    const { why: _old, ...kept } = ledger.hold;
    ledger.hold = { ...kept, for: who, evidence, ...(why && { why }) };
    return { ledger, next: ledger.next };
  }
  if (expects(ledger) !== "report")
    throw new Error(
      `hold is for a builder's round: the lane is ${ledger.state} (next ${ledger.next})`,
    );
  const round = last(ledger);
  round.held = true;
  const entry = {
    for: who,
    when: "during",
    stepRun: round.stepRun ?? null,
    evidence,
    since: at,
    round: round.n,
    ...(why && { why }),
  };
  return hold(ledger, entry, who === "later" ? "parked" : "the owner looks before the round ends");
}

// The owner's answer ends a hold: recorded in `holds[]`, then the held round's builder carries on with
// the next run (or, `redo`, the same run again; after a "during" hold, the same round's work), or after
// the last step the built work goes on as a report would send it.
function onResume(ledger, event) {
  const { note, redo = false, at } = event;
  const held = ledger.hold;
  if (ledger.state !== "held" || !held)
    throw new Error(`the lane is not held (state ${ledger.state}, next ${ledger.next})`);
  if (redo && held.when !== "after")
    throw new Error(
      "--redo goes back over a finished run; this hold is during one, and resume carries on in it",
    );
  const { round: n, ...kept } = held;
  ledger.holds = [...(ledger.holds ?? []), { ...kept, resumedAt: at, note, redo }];
  ledger.hold = undefined;
  const round = ledger.rounds[n - 1] ?? last(ledger);
  const carryOn = (stepRun, reason, extra = {}) =>
    send(
      ledger,
      "continue",
      {
        from: held.evidence ?? round.reportPath,
        agent: round.agent,
        ...(stepRun && { stepRun }),
        ...extra,
      },
      reason,
    );
  const total = ledger.steps?.length ?? 0;
  if (held.when !== "after")
    return carryOn(
      held.stepRun,
      held.for === "later" ? "the parked round carries on" : "the owner answered during the round",
    );
  if (redo)
    return carryOn(held.stepRun, `the owner sent ${runText(held.stepRun, total)} back`, {
      redo: true,
    });
  const g = held.stepRun?.[1] ?? total;
  if (g < total)
    return carryOn(
      runOf(ledger.steps, g + 1),
      `the owner approved ${runText(held.stepRun, total)}`,
    );
  return routeBuilt(ledger, round, event);
}

function onVerdict(ledger, round, { verdict, tip, gate = true }) {
  if (tip !== round.tip) {
    round.void = true;
    if (ledger.rounds.filter((r) => r.void).length >= MAX_VOIDS)
      return stop(
        ledger,
        `${MAX_VOIDS} void verdicts: the branch tip kept moving while its verifiers read`,
      );
    return send(
      ledger,
      "recheck",
      { from: round.reportPath, agent: round.agent },
      `the branch tip moved from ${short(round.tip)} to ${short(tip)} while the verifier read; its verdict is void`,
    );
  }
  if (!verdict) return resend(ledger, round, "the report has no `Verdict:` last line");
  round.verdict = verdict;
  if (verdict === "FAIL") {
    if (round.step === "final") return stop(ledger, "the final verifier's verdict is FAIL");
    if (verdicts(ledger).length >= MAX_VERDICTS)
      return stop(ledger, `FAIL at verdict ${MAX_VERDICTS}; every verdict goes to the owner`);
    const builder = builders(ledger).at(-1);
    return send(
      ledger,
      "fix",
      { from: round.reportPath, agent: builder?.agent },
      "the verifier's FAIL",
    );
  }
  if (round.step === "recheck") return send(ledger, "final", {}, null);
  if (!gate) return settle(ledger, "close", "no gate in the workflow file: closes on the verdict");
  if (greenOn(ledger.gates, tip))
    return settle(ledger, "close", "a green worktree gate on this tip");
  return settle(ledger, "gate", "no green worktree gate on this tip yet");
}

/** The notes-fix rounds a lane has run and the most it may: the verdict budget, so fixing notes cannot
 *  outlast the cap the verdicts have. */
export const notesBudget = (ledger) => ({
  used: ledger.rounds.filter((r) => r.notes).length,
  max: MAX_VERDICTS,
});

// A verified lane (PASS WITH NOTES, gate or close next) sends the builder back to fix the named notes; the
// round after it is the usual recheck by the verifier.
function onNotes(ledger, notes) {
  const verifier = verdicts(ledger).at(-1);
  if (verifier?.verdict !== "PASS WITH NOTES" || !["gate", "close"].includes(ledger.next))
    throw new Error(
      `notes can be fixed only after a PASS WITH NOTES verdict, before the lane closes (state ${ledger.state})`,
    );
  const { used, max } = notesBudget(ledger);
  if (used >= max) throw new Error(`${used} of ${max} notes rounds are used`);
  const builder = builders(ledger).at(-1);
  return send(
    ledger,
    "fix",
    { from: verifier.reportPath, agent: builder?.agent, notes },
    `the verifier's notes ${notes.join(", ")}`,
  );
}

function onGate(ledger, record) {
  ledger.gates.push(record);
  if (ledger.next !== "gate") return { ledger, next: ledger.next };
  // A red that failed only in listed flaky tests is re-run alone; the re-run's record decides.
  if (record.flakyRed?.length) return { ledger, next: ledger.next };
  const verified =
    verdicts(ledger).at(-1)?.tip ?? ledger.rounds.findLast((r) => r.builtTip)?.builtTip;
  if (record.commit !== verified)
    return stop(ledger, `the branch moved from ${short(verified)} since the verdict`);
  if (!greenOn([record], verified))
    return stop(ledger, `the worktree gate is red (${gateWhy(record)})`);
  return settle(ledger, "close", "the worktree gate is green");
}

const gateWhy = (r) =>
  r.exit !== 0 ? `exit ${r.exit}` : r.cleanAfter ? "not clean before" : "it left files behind";
const short = (sha) => (typeof sha === "string" ? sha.slice(0, 7) : String(sha));
