// rounds — the exec round machine (plan R1b §3.2, pinned). PURE: no I/O, no clock; the caller hands in
// every fact (the report's status, the guards it measured, the branch tip, the gate record) and gets back
// a new ledger (the input is never changed) and the next step.
//
//   start                                   → build (fresh)
//   build / fix: DONE or DONE_WITH_CONCERNS → verify (fresh) when no verdict yet, else recheck (resume)
//   build / fix: DONE, and the report says to skip the verifier (exec.verify) and a gate is configured
//                                           → gate (green on this tip) → close: the gate stands in for the verifier
//   build / fix: main touched (any status)  → stop
//   build / fix: uncommitted files or no commits past base → fix (resume) with the reason; twice → stop
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
//
// Every budget is the lane's, so no mix of outcomes resets one: one resend per role, one needs-context
// round, three counted verdicts (a final after a recheck PASS is the one more), three void ones, and a
// guard fix (resent or not) that trips a guard again stops. So every lane ends.
//
// A round in the ledger: { n, step, role, mode, final?, resend?, guard?, agent?, from?, reason?, brief,
// reportPath, tip, at } plus, once reported, { report, status | verdict, void?, summary?, guards? }.
export const MAX_VERDICTS = 3;
export const MAX_VOIDS = 3;
export const PASSES = ["PASS", "PASS WITH NOTES"];

// What each dispatch step sends: the agent's role and whether it resumes the agent of an earlier round.
const STEPS = {
  build: { role: "build", mode: "fresh" },
  fix: { role: "build", mode: "resume" },
  "needs-context": { role: "build", mode: "resume" },
  verify: { role: "verify", mode: "fresh" },
  recheck: { role: "verify", mode: "resume" },
  final: { role: "verify", mode: "fresh", final: true },
};
export const DISPATCHES = [...Object.keys(STEPS), "resend"];

// The ledger state while each step is next.
const STATE = {
  build: "building",
  "needs-context": "building",
  fix: "fixing",
  verify: "verifying",
  recheck: "verifying",
  final: "verifying",
  gate: "verifying",
  close: "verified",
  stop: "stopped",
};

const last = (ledger) => ledger.rounds.at(-1);
const builders = (ledger) => ledger.rounds.filter((r) => r.role === "build");
const verifiers = (ledger) => ledger.rounds.filter((r) => r.role === "verify");
/** The verdicts that count: every verify round that gave one and was not voided. */
export const verdicts = (ledger) =>
  verifiers(ledger).filter((r) => typeof r.verdict === "string" && !r.void);

/** What the lane waits for: "report" (a builder's), "verdict" (a verifier's), "gate", "close", or null
 *  when nothing is dispatched or due (stopped, or already closed). */
export function expects(ledger) {
  if (ledger.state === "stopped") return null;
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
 *  `red` that failed only in tests the process file lists as flaky (and was re-run). `text` is the one
 *  line the verdict shows ("1 green, 1 red on this tip"), or null when there is no gate on this tip. */
export function gateTally(gates, tip) {
  const here = (gates ?? []).filter((g) => g.where === "worktree" && g.commit === tip);
  const green = here.filter((g) => g.exit === 0).length;
  const red = here.length - green;
  const flaky = here.filter((g) => g.exit !== 0 && g.flakyRed?.length).length;
  const text =
    here.length === 0
      ? null
      : `${green} green, ${red} red on this tip${flaky ? ` (${flaky} red only in flaky tests)` : ""}`;
  return { green, red, flaky, text };
}

/** The plan for the first round of a new lane. */
export const begin = () => ({ next: "build", dispatch: { step: "build", ...STEPS.build } });

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
 *   { type: "report", status, report, agent?, summary?, guards: { mainTouched?, dirty?, commits? },
 *     skipVerify?: true (exec.verify routes this item past the verifier), tip, gate: true | false }
 *   { type: "verdict", verdict, report, agent?, summary?, tip, gate: true | false (one configured) }
 *   { type: "gate", record }   (recorded at any time; decides only when the gate is the next step)
 */
export function step(ledger, event) {
  const out = structuredClone(ledger);
  out.gates ??= [];
  if (event.type === "gate") return onGate(out, event.record);
  if (event.type === "notes") return onNotes(out, event.notes);
  const want = expects(out);
  if (want !== event.type)
    throw new Error(`the lane expects ${want ?? "nothing"}, not a ${event.type}`);
  const round = last(out);
  round.report = event.report;
  if (event.agent) round.agent = event.agent;
  if (event.summary) round.summary = event.summary;
  return event.type === "report" ? onReport(out, round, event) : onVerdict(out, round, event);
}

function onReport(ledger, round, { status, guards = {}, skipVerify = false, tip, gate = true }) {
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
  if (!gate) return settle(ledger, "close", "no gate in the process file: closes on the verdict");
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
