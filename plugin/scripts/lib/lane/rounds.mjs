// rounds — the exec round machine (plan R1b §3.2, pinned). PURE: no I/O, no clock; the caller hands in
// every fact (the report's status, the guards it measured, the branch tip, the gate record) and gets back
// a new ledger (the input is never changed) and the next step.
//
//   start                                   → build (fresh)
//   build / fix: DONE or DONE_WITH_CONCERNS → verify (fresh) when no verdict yet, else recheck (resume;
//                                             fresh when the last verdict is one a restart carried)
//   build / fix: DONE, and the report says to skip the verifier (exec.verify) and a gate is configured
//                                           → gate (green on this tip) → close: the gate stands in for the verifier
//   build / fix: main touched (any status)  → held for the guard: the round is left unread, its report
//                                             saved; a report again while held reads it once more: main clean
//                                             → as the first report would have, still touched → held again
//   build / fix: uncommitted files, no commits past base, or a commit that breaks the workflow file's
//                `commits` rules                    → fix (resume) with the reason; twice → stop
//   build / fix: NEEDS_CONTEXT              → needs-context (resume) once per step (the run of `steps` the
//                                             builder is on; a lane with no steps is one step), then held
//                                             for the context (`hold.for: "context"`): the report read, its
//                                             first line the hold's reason
//   held for the context: { type: "resume", note } → needs-context (resume the builder) with the note as
//                                             `fact`; a hold never sends a builder by itself
//   build / fix: BLOCKED: external: <why>   → held (`for: "blocked"`, no verdict spent): resume sends the
//                                             same round again (a fresh builder unless `same`)
//   build / fix: BLOCKED                    → stop; no status line → resend once, then stop
//   verify / recheck / final: tip moved     → recheck: the verdict is void (no rebase while one reads);
//                                             the 3rd void verdict → stop
//   verify: PASS*                           → gate (no green worktree gate on this tip), then close
//   recheck: PASS*, route final "always"    → final (fresh, against the full bar)
//   recheck: PASS*, route final "never"     → gate, or close when green on this tip
//   recheck: PASS*, final "after-fix", the verdict `covered` every note sent back and the tip moved only by
//            fix commits (`onlyFixCommits`) → gate / close; otherwise → final. A note the verdict before left
//            as built (`verdict --leave`, the ledger's `left[]`) is not sent back, so it never forces a final
//   final: PASS* / FAIL                     → gate → close / stop
//   verify / recheck: FAIL                  → fix (resume the builder); at the lane's 3rd verdict → stop
//   no `Verdict:` last line                 → resend once, then stop
//   verified PASS WITH NOTES (gate or close next): { type: "notes" }, notes rounds used < the cap
//                                           → fix (resume the builder) on the named notes, then the usual
//                                             recheck; at the budget (0 under lean) refused: the lane goes on to
//                                             gate / close with its notes kept open. The cap is the event's
//                                             `noteRounds` (the workflow file's, read at the call), else the route's
//   verify / recheck / final: PASS*, gate or close next, at the notes cap, the item flagged and notes open
//                                           → held for the owner (`when: "verdict"`): resume → gate / close as
//                                             the verdict would have; { type: "owner" } → fix on the change
//   verified (next close or merge): { type: "rebase" } → rebase (resume the last builder)
//   verified (next close or merge): { type: "owner", note, at } → fix (resume the last builder) on the owner's
//                                             change, `ownerFixes[]` recording it; its report goes as any fix's:
//                                             the gate on the new tip under a route that skipped the verifier,
//                                             else a recheck by the last verifier
//   verified, the branch already moved: { type: "rebased", tip, changed } → as a rebase report below
//   rebase: DONE*, guards hold, `changed`, route rebase "recheck" → resolve (a fresh verifier)
//   rebase: DONE*, guards hold, otherwise   → gate on the new tip, or close when green on it
//   rebase: a guard trips                   → rebase again (resume) with the reason; twice → stop
//   rebase: NEEDS_CONTEXT                   → stop: a conflict the builder can't settle goes to the owner
//   resolve: PASS*                          → gate / close; FAIL → stop; tip moved → void, resolve again
//   verified with no verdict (the route skipped the verifier): { type: "reverify" } → verify (fresh), then
//                                             the usual rows
//   gate: red only in listed flaky tests    → no decision: the alone re-run's record decides
//   start, the contract has steps            → build (fresh) on the first run: steps 1..g, g the first step
//                                             ending "→ owner OK", else the last step; a restart --carry that
//                                             passed an owner gate → continue (fresh) on the run it stopped in
//   build / fix / continue on run a..g, no verdict yet: DONE or DONE_WITH_CONCERNS, guards hold
//                                           → hold (held) when step g ends "→ owner OK"; else g is the last
//                                             step: as build above (verify, or the gate under exec.verify)
//   build / fix / continue on run a..g (a > 1): no commits since step a began → fix (resume) with the reason
//                                             (a run the owner sent back with redo, from its own dispatch)
//   { type: "hold" } while a builder's round is out → hold (held); the round is left unread
//   held: { type: "resume", note }           → continue (fresh builder, the last report pointed to) on the next
//                                             run, `same` keeping the old builder (resume); on the same run, the
//                                             builder resumed, after a "during" hold or with redo; after the last step → verify
//                                             (fresh), or the gate under exec.verify
//   held: report / verdict / notes           → refused: the lane expects a resume (a guard hold takes a report,
//                                             as above); a gate is recorded, decides nothing
//   verified (next close or merge): { type: "hold", for: "later" } → held (`when: "verified"`, the next step
//                                             kept); no round changes. Resumed → verified, the same next step
//   restack, resolution none, a verdict or builtTip → gate (verifying): the verdict stands for the same
//                                             commits; a gate on the old tip no longer counts
//   restack, resolution by hand, a verdict     → R1d-11's A48 resolution recheck on the restack's ranges
//   restack, no verdict yet (held)             → no change: the one verifier after the build reads it all
//   restack, a guard hold or a parked verified lane → refused: its report, or its resume, comes first
//
// Every budget is the lane's, so no mix of outcomes resets one: one resend per role, one needs-context
// round per step (the owner's resume past a step hold starts the next step), three counted verdicts (a
// final after a recheck PASS is the one more; one a restart carried counts the old lane's), three void ones, and a guard fix (resent or not) that trips
// a guard again stops. So every lane ends. A hold waits for the owner, who ends it with a resume; the
// owner's answers spend no budget.
//
// A round in the ledger: { n, step, role, mode, final?, resend?, guard?, agent?, from?, reason?,
// stepRun?, redo?, owner?, brief, reportPath, tip, at } plus, once reported, { report, status | verdict, void?,
// summary?, guards?, covered?, onlyFixCommits? }, or `held: true` when the lane was held before its report
// was read. A held lane has `hold: { for, when, stepRun, evidence, since, round, why? }` (a guard hold also
// `reason` and `report`, the saved report a report reads again; a context hold `reason` and `report`, the
// read report; a notes-cap hold `when: "verdict"`, `reason` and `tip`, the verdict's; a parked verified lane
// `{ for: "later", when: "verified", next, evidence, since, why? }`); each resume appends its answer to
// `holds[]`: { for, when, stepRun, evidence, since, resumedAt, note, redo, why? }.
//
// The route is the ledger's snapshot from start, `route: { verify, flagged, preset, noteRounds, final,
// rebase }`: an edit of the workflow file mid-lane changes no running lane's verify, final or rebase, and a
// key the ledger lacks reads as the standard preset's. The notes cap is the caller's live read when an
// event gives `noteRounds` (field 84); the snapshot's only when none is given. The machine writes `gateTip` whenever it settles `gate` and `closedTip`
// whenever it settles `close`: the tips the gate and the land check.
//
// A stacked lane (`on`, A45) is restacked only with no agent out: each restack appends `restacks[]`:
// { at, parent, onto: "parent" | "main", from, to, base: { from, to }, resolution: "none" | "by hand",
// rangeDiff? } and sets `base` to `base.to`; one onto main drops `on`.
import { PRESETS } from "../process/spec/presets.mjs";
import { runOf, runText } from "../process/steps.mjs";
import { SUMMARY_CUT } from "./report.mjs";

export const MAX_VERDICTS = 3;
export const MAX_VOIDS = 3;
export const PASSES = ["PASS", "PASS WITH NOTES"];

// What each dispatch step sends: the agent's role and whether it resumes the agent of an earlier round.
const STEPS = {
  build: { role: "build", mode: "fresh" },
  fix: { role: "build", mode: "resume" },
  "needs-context": { role: "build", mode: "resume" },
  continue: { role: "build", mode: "resume" },
  rebase: { role: "build", mode: "resume" },
  verify: { role: "verify", mode: "fresh" },
  recheck: { role: "verify", mode: "resume" },
  final: { role: "verify", mode: "fresh", final: true },
  resolve: { role: "verify", mode: "fresh" },
};
export const DISPATCHES = [...Object.keys(STEPS), "resend"];

// The ledger state while each step is next.
const STATE = {
  build: "building",
  "needs-context": "building",
  continue: "building",
  rebase: "building",
  fix: "fixing",
  verify: "verifying",
  recheck: "verifying",
  final: "verifying",
  resolve: "verifying",
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
// The lane's own: a verdict a restart carried from the archive spent the old lane's budget, not this one's.
const ownVerdicts = (ledger) => verdicts(ledger).filter((r) => !r.carried);

/** The lane's route: its ledger snapshot, each key it lacks (an older ledger) the standard preset's. */
export const routeOf = (ledger) => ({ ...PRESETS.standard.exec, ...ledger?.route });

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

/** Is the newest worktree gate record (of `tier`, when given) green on commit `tip`: exit 0 on a tree clean
 *  before and after. A red record after a green one is the newest, so the green no longer counts. */
export const greenOn = (gates, tip, tier) => {
  const g = (gates ?? []).findLast(
    (r) => r.where === "worktree" && (tier === undefined || r.tier === tier),
  );
  return (
    g !== undefined &&
    g.exit === 0 &&
    g.cleanBefore === true &&
    g.cleanAfter === true &&
    g.commit === tip
  );
};

/** Does `route` (the ledger's `{ verify, flagged, … }`, absent on an older ledger) send a built item straight
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

/** The plan for a restarted lane's first round (field 99): a fresh builder `continue`s the run the old lane
 *  stopped in (`stepRun`, past step 1), `from` the old builder's last report, never step 1 again. */
export const beginAt = (stepRun, from, reason) => ({
  next: "continue",
  dispatch: {
    step: "continue",
    ...STEPS.continue,
    mode: "fresh",
    from,
    stepRun,
    ...(reason && { reason }),
  },
});

/** Append the round `dispatch` describes (from `begin`, `beginAt` or `step`), with its files and the branch tip at
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
// The tip a settled gate must run on, and the one a closed lane lands: kept in the ledger.
const settle = (ledger, next, reason, tip) => {
  ledger.next = next;
  ledger.state = STATE[next];
  if (next === "gate" && tip !== undefined) ledger.gateTip = tip;
  if (next === "close" && tip !== undefined) ledger.closedTip = tip;
  return { ledger, next, reason };
};
// Checked work goes on to the gate, or closes on a green gate of the build tier on this tip (or with no gate).
const gateOrClose = (ledger, tip, { gate = true, tier }, reason) => {
  if (!gate)
    return settle(ledger, "close", "no gate in the workflow file: closes on the verdict", tip);
  if (greenOn(ledger.gates, tip, tier))
    return settle(ledger, "close", "a green worktree gate on this tip", tip);
  return settle(ledger, "gate", reason ?? "no green worktree gate on this tip yet", tip);
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
 *   { type: "report", status, blocked? (the reason of a `BLOCKED: external: <why>` report), report, agent?, summary?, guards: { mainTouched?, dirty?, commits?, subjects?: [{ sha, subject, why, failed? }] },
 *     skipVerify?: true (exec.verify routes this item past the verifier), tip, gate: true | false, tier?,
 *     changed? (a rebase report: the range-diff has a pair not marked `=`), saved? (where the report is
 *     kept while a guard holds the lane; `report` when not given), at }
 *   { type: "verdict", verdict, report, agent?, summary?, tip, gate: true | false (one configured), tier?,
 *     covered?, onlyFixCommits? (a recheck's facts, computed by the caller and pinned on the round) }
 *   { type: "gate", record }   (recorded at any time; decides only when the gate is the next step)
 *   { type: "notes", notes }   (a verified PASS WITH NOTES lane back to its builder)
 *   { type: "hold", for: "owner" | "later", evidence, at, why?, agent? }
 *   { type: "resume", note, redo?, same? (the next step keeps the old builder), at, skipVerify?, tip, gate, tier? }
 *   { type: "rebase" } / { type: "rebased", tip, changed, gate, tier? } / { type: "reverify" }
 *                              (a verified lane: rebased by its builder, already rebased, or verified late)
 *   { type: "owner", note, at } (a verified lane the owner sends back with a change)
 *   { type: "restack", from, to, base: { from, to }, onto, parent, resolution, gate, at, rangeDiff? }
 *                              (a stacked lane's branch moved onto its parent's tip or main, no agent out)
 *
 * `tier` is the gate tier the build role runs: a green record of it on the tip closes the lane.
 */
export function step(ledger, event) {
  const out = structuredClone(ledger);
  out.gates ??= [];
  if (event.type === "gate") return onGate(out, event.record);
  if (event.type === "restack") return onRestack(out, event);
  const parked = event.type === "report" && out.hold?.for === "guard" ? unpark(out) : null;
  const ownerAnswers = ["owner", "notes"].includes(event.type) && capHeld(out);
  if (out.state === "held" && !["hold", "resume"].includes(event.type) && !ownerAnswers)
    throw new Error(`the lane is held: it expects a resume, not a ${event.type}`);
  if (event.type === "notes") return onNotes(out, event);
  if (event.type === "rebase") return onRebase(out);
  if (event.type === "rebased") return afterRebase(verified(out, "rebased"), event);
  if (event.type === "reverify") return onReverify(out);
  if (event.type === "owner") return onOwnerFix(out, event);
  if (event.type === "hold") return onHold(out, event);
  if (event.type === "resume") return onResume(out, event);
  const want = expects(out);
  if (want !== event.type)
    throw new Error(`the lane expects ${want ?? "nothing"}, not a ${event.type}`);
  const round = last(out);
  round.report = event.report;
  if (event.agent) round.agent = event.agent;
  if (event.summary) round.summary = event.summary;
  const res = inRun(
    out,
    event.type === "report" ? onReport(out, round, event) : onVerdict(out, round, event),
  );
  // Tripped again: still held since the first trip, with the new reason.
  if (parked && out.hold?.for === "guard") out.hold.since = parked.since;
  return res;
}

// A lane a guard trip holds reads its report again: its round is out once more, as it was dispatched.
// Returns the hold it ends.
function unpark(ledger) {
  const held = ledger.hold;
  const round = ledger.rounds[held.round - 1];
  for (const key of ["report", "status", "summary", "guards", "held"]) delete round[key];
  ledger.hold = undefined;
  ledger.next = round.resend ? "resend" : round.step;
  ledger.state = STATE[round.step];
  return held;
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

// One trip line per commit that breaks a `commits` rule, at most SUBJECT_TRIPS, then how many more. A
// commit git could not read (`failed`) is not a subject to reword: the branch needs a look.
const SUBJECT_TRIPS = 5;
function subjectTrips(broken = []) {
  const lines = broken
    .slice(0, SUBJECT_TRIPS)
    .map((c) =>
      c.failed
        ? `cannot read commit ${c.sha.includes("..") ? c.sha : short(c.sha)}: ${c.why} → check the branch, then report again`
        : `commit ${short(c.sha)} "${c.subject}": ${c.why} → reword it on the branch (git commit --amend for the tip, or a rebase with exec, no -i)`,
    );
  if (broken.length > SUBJECT_TRIPS) lines.push(`+${broken.length - SUBJECT_TRIPS}`);
  return lines;
}

const sameRun = (a, b) => a?.[0] === b?.[0] && a?.[1] === b?.[1];

// A context hold's reason: the report's summary, which its reader cuts at a length cap ("…"), cut back to
// the last word boundary that leaves no backticked span or parenthesis open. Only the reader's cut is: a
// body of its cut length (`summaryOf`'s `SUMMARY_CUT`); a report's own "…" stays as written.
function clipped(summary) {
  const body = summary.slice(0, -1);
  if (!summary.endsWith("…") || body.length !== SUMMARY_CUT) return summary;
  const count = (text, ch) => text.split(ch).length - 1;
  for (let at = body.lastIndexOf(" "); at > 0; at = body.lastIndexOf(" ", at - 1)) {
    const head = body.slice(0, at).trimEnd();
    if (head && count(head, "`") % 2 === 0 && count(head, "(") <= count(head, ")"))
      return `${head}…`;
  }
  return summary;
}

// The round the lane's current step began with: the first builder round of the newest run (`steps`) a
// builder was sent on; round 1 when there are no steps. The needs-context budget counts from it.
function stepStart(ledger) {
  const run = builders(ledger).findLast((r) => r.stepRun)?.stepRun;
  return run ? builders(ledger).find((r) => sameRun(r.stepRun, run)).n : 1;
}

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
  // A builder report that finds the main checkout changed holds the lane whatever it says: the round is
  // left unread and its report kept, for a report once main is fixed.
  if (guards.mainTouched) {
    round.guards = [`main touched: ${guards.mainTouched}`];
    for (const key of ["report", "status", "summary"]) delete round[key];
    round.held = true;
    const saved = event.saved ?? event.report;
    const entry = {
      for: "guard",
      when: "during",
      stepRun: round.stepRun ?? null,
      evidence: saved,
      reason: guards.mainTouched,
      report: saved,
      since: event.at,
      round: round.n,
    };
    return hold(ledger, entry, `guard tripped: ${guards.mainTouched}`);
  }
  if (!status) return resend(ledger, round, "the report has no status line");
  if (status === "BLOCKED" && event.blocked) {
    // An outside cause (`BLOCKED: external: <reason>`): nothing the builder can fix, so the lane waits
    // for the owner. No verdict is spent and the step pointer stays: the resume sends the same round.
    const entry = {
      for: "blocked",
      when: "during",
      stepRun: round.stepRun ?? null,
      evidence: round.reportPath,
      reason: event.blocked,
      report: round.reportPath,
      since: event.at,
      round: round.n,
    };
    return hold(ledger, entry, `blocked by an outside cause: ${event.blocked}`);
  }
  if (status === "BLOCKED") return stop(ledger, "the builder reported BLOCKED");
  const rebasing = round.step === "rebase";
  if (status === "NEEDS_CONTEXT" && rebasing)
    return stop(ledger, "NEEDS_CONTEXT on the rebase: the conflict goes to the owner");
  if (status === "NEEDS_CONTEXT") {
    // Asked again in this step: the owner supplies the fact (the worktree is left as it is).
    const from = stepStart(ledger);
    if (builders(ledger).some((r) => r.step === "needs-context" && r.n >= from)) {
      const entry = {
        for: "context",
        when: "during",
        stepRun: round.stepRun ?? null,
        evidence: round.reportPath,
        reason: clipped(event.summary || status),
        report: round.reportPath,
        since: event.at,
        round: round.n,
      };
      return hold(ledger, entry, "NEEDS_CONTEXT again in this step: the owner supplies the fact");
    }
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
      rebasing ? "rebase" : "fix",
      { guard: true, from: round.reportPath, agent: round.agent },
      trips.join("; "),
    );
  }
  if (rebasing) {
    round.builtTip = tip;
    return afterRebase(ledger, event);
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
function routeBuilt(ledger, round, { skipVerify = false, tip, gate = true, tier }) {
  if (verdicts(ledger).length === 0) {
    // Skipping the verifier needs a gate to stand in for it: with none, nothing would check the work.
    if (!skipVerify || !gate) return send(ledger, "verify", {});
    round.builtTip = tip;
    return gateOrClose(ledger, tip, { tier }, "no verifier for this item: the gate decides");
  }
  const verifier = verdicts(ledger).at(-1);
  // A carried round's verifier belongs to the archived lane: its recheck reads that report afresh.
  const who = verifier.carried ? { mode: "fresh" } : { agent: verifier.agent };
  return send(ledger, "recheck", { from: verifier.reportPath, ...who }, null);
}

const hold = (ledger, entry, reason) => {
  ledger.hold = entry;
  return settle(ledger, "resume", reason);
};

/** The reason a flagged item's lane holds at the notes cap with notes open (field 84). */
export const CAP_REASON = "notes cap reached with open notes on a flagged item";
const capHeld = (ledger) => ledger.state === "held" && ledger.hold?.when === "verdict";

// A verified lane the conductor parks (field 63): only for later, as the owner's review is of a builder's round.
const ownerHoldRefusal = "hold --for owner is for a builder's round";
const parkedVerified = (ledger) => ledger.state === "held" && ledger.hold?.when === "verified";

// The owner looks at a builder's round that is out (`for: "owner"`), or the conductor parks a lane whose
// builder was stopped (`for: "later"`): the round is left unread. A held lane takes the new `for` and
// evidence and keeps its `since`. A verified lane parks with its next step kept, no round touched.
function onHold(ledger, { for: who, evidence = null, at, why, agent }) {
  const verifiedNow = ledger.state === "verified" && ["close", "merge"].includes(ledger.next);
  if ((verifiedNow || parkedVerified(ledger)) && who !== "later")
    throw new Error(`${ownerHoldRefusal}: the lane is verified`);
  if (verifiedNow) {
    const entry = { for: who, when: "verified", next: ledger.next, evidence, since: at };
    return hold(ledger, { ...entry, ...(why && { why }) }, "parked, verified");
  }
  // `agent`: the builder out on the round, so the resume can send `continue` to it.
  if (agent && !parkedVerified(ledger))
    ledger.rounds[(ledger.hold?.round ?? ledger.rounds.length) - 1].agent = agent;
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

/** Why `resume --redo` is refused on `hold` (any hold but one after a run): what the resume does instead. */
export const redoRefusal = (hold) =>
  hold?.when === "verified"
    ? "--redo goes back over a finished run; this lane was parked verified, and resume makes it verified again"
    : "--redo goes back over a finished run; this hold is during one, and resume carries on in it";

// The owner's answer ends a hold: recorded in `holds[]`, then the held round's builder carries on with
// the next run (or, `redo`, the same run again; after a "during" hold, the same round's work), or after
// the last step the built work goes on as a report would send it.
function onResume(ledger, event) {
  const { note, redo = false, at } = event;
  const held = ledger.hold;
  if (ledger.state !== "held" || !held)
    throw new Error(`the lane is not held (state ${ledger.state}, next ${ledger.next})`);
  if (redo && held.when !== "after") throw new Error(redoRefusal(held));
  const { round: n, next, ...kept } = held;
  ledger.holds = [...(ledger.holds ?? []), { ...kept, resumedAt: at, note, redo }];
  ledger.hold = undefined;
  // A parked verified lane is verified again, its next step as it was: no builder is sent.
  if (held.when === "verified") {
    ledger.state = "verified";
    ledger.next = next;
    return { ledger, next, reason: "the parked lane is verified again" };
  }
  const round = ledger.rounds[n - 1] ?? last(ledger);
  // A fresh builder (a new step's) is no agent of an earlier round: it gets the brief and a pointer to
  // the last report (`from`), and its model and agent come from the step's own markers.
  const carryOn = (stepRun, reason, extra = {}) =>
    send(
      ledger,
      "continue",
      {
        from: held.evidence ?? round.reportPath,
        ...(extra.mode !== "fresh" && { agent: round.agent }),
        ...(stepRun && { stepRun }),
        ...extra,
      },
      reason,
    );
  // The notes cap held a flagged item for the owner: the OK closes it as is, as the verdict would have.
  if (held.when === "verdict")
    return gateOrClose(
      ledger,
      held.tip,
      { gate: event.gate ?? true, tier: event.tier },
      "the owner's OK: it goes on with its notes open",
    );
  // The owner supplied the fact a builder asked for twice in one step: the same re-dispatch as the first.
  if (held.for === "context")
    return send(
      ledger,
      "needs-context",
      {
        from: held.report,
        agent: round.agent,
        ...(held.stepRun && { stepRun: held.stepRun }),
        fact: note,
      },
      "the owner supplied the fact",
    );
  // The outside cause the builder reported is cleared: the round it stopped on goes again, as it was
  // dispatched (its `from`, `reason`, `fact`, notes, owner's change, guard and run), to a fresh builder
  // unless the owner asked for the old one (`same`). The block and the owner's words join its fact.
  if (held.for === "blocked") {
    const { reason, ...dispatched } = Object.fromEntries(
      ["from", "reason", "stepRun", "notes", "owner", "guard", "redo"]
        .filter((key) => round[key] !== undefined)
        .map((key) => [key, round[key]]),
    );
    const fact = [
      round.fact,
      `The last builder stopped on: ${held.reason} (its report ${held.report}).`,
      `What changed: ${note}`,
    ];
    return send(
      ledger,
      round.step,
      {
        ...dispatched,
        ...(event.same ? { mode: "resume", agent: round.agent } : { mode: "fresh" }),
        fact: fact.filter(Boolean).join("\n\n"),
      },
      reason ?? "the outside cause is cleared: the same round goes again",
    );
  }
  const total = ledger.steps?.length ?? 0;
  // A rebase held during its round carries on as the rebase, so its report is read as one.
  if (held.when !== "after" && round.step === "rebase")
    return send(
      ledger,
      "rebase",
      { from: held.evidence ?? round.reportPath, agent: round.agent },
      "the held rebase carries on",
    );
  if (held.when !== "after")
    return carryOn(
      held.stepRun,
      held.for === "later"
        ? "the parked round carries on"
        : held.for === "guard"
          ? "the round held by the guard carries on"
          : "the owner answered during the round",
    );
  if (redo)
    return carryOn(held.stepRun, `the owner sent ${runText(held.stepRun, total)} back`, {
      redo: true,
    });
  const g = held.stepRun?.[1] ?? total;
  // The next step starts a fresh builder, unless the owner asked for the old one (`same`).
  if (g < total)
    return carryOn(
      runOf(ledger.steps, g + 1),
      `the owner approved ${runText(held.stepRun, total)}`,
      event.same ? {} : { mode: "fresh" },
    );
  return routeBuilt(ledger, round, event);
}

function onVerdict(ledger, round, event) {
  const { verdict, tip, gate = true, tier } = event;
  if (tip !== round.tip) {
    round.void = true;
    if (ledger.rounds.filter((r) => r.void).length >= MAX_VOIDS)
      return stop(
        ledger,
        `${MAX_VOIDS} void verdicts: the branch tip kept moving while its verifiers read`,
      );
    const moved = `the branch tip moved from ${short(round.tip)} to ${short(tip)} while the verifier read; its verdict is void`;
    // A resolution is read again by a fresh verifier: it judges the range-diff, not earlier findings.
    if (round.step === "resolve") return send(ledger, "resolve", {}, moved);
    return send(ledger, "recheck", { from: round.reportPath, agent: round.agent }, moved);
  }
  if (!verdict) return resend(ledger, round, "the report has no `Verdict:` last line");
  round.verdict = verdict;
  if (round.step === "resolve") {
    if (verdict === "FAIL") return stop(ledger, "the conflict resolution failed its check");
    return gateOrClose(ledger, tip, { gate, tier });
  }
  if (verdict === "FAIL") {
    if (round.step === "final") return stop(ledger, "the final verifier's verdict is FAIL");
    if (ownVerdicts(ledger).length >= MAX_VERDICTS)
      return stop(ledger, `FAIL at verdict ${MAX_VERDICTS}; every verdict goes to the owner`);
    const builder = builders(ledger).at(-1);
    return send(
      ledger,
      "fix",
      { from: round.reportPath, agent: builder?.agent },
      "the verifier's FAIL",
    );
  }
  if (round.step === "recheck") {
    round.covered = Boolean(event.covered);
    round.onlyFixCommits = Boolean(event.onlyFixCommits);
    const why = finalWhy(routeOf(ledger).final, round);
    if (why) return send(ledger, "final", {}, why);
  }
  return capHold(ledger, round, event) ?? gateOrClose(ledger, tip, { gate, tier });
}

// A flagged item never closes over an open note by the notes cap alone (field 84): a verdict that leaves
// notes open (`openNotes`, counted by the caller) at the cap holds the lane for the owner, the verdict's
// tip kept for the gate the resume settles. null when the lane goes on.
function capHold(ledger, round, { tip, flagged, openNotes = 0, noteRounds, at }) {
  if (!(flagged ?? routeOf(ledger).flagged) || openNotes === 0) return null;
  const { used, max } = notesBudget(ledger, noteRounds);
  if (used < max) return null;
  const entry = {
    for: "owner",
    when: "verdict",
    stepRun: null,
    evidence: round.reportPath,
    reason: CAP_REASON,
    tip,
    since: at,
    round: round.n,
  };
  return hold(ledger, entry, CAP_REASON);
}

// Why a recheck's PASS sends a final verifier (null: it does not): always under `final: "always"`, never
// under "never", and under "after-fix" unless the recheck covered every note sent back and the tip moved
// only by the fix commits.
function finalWhy(final, round) {
  if (final === "never") return null;
  if (final === "always") return 'exec.final is "always"';
  if (!round.covered)
    return 'exec.final is "after-fix" and the recheck did not pass every note sent back';
  if (!round.onlyFixCommits)
    return 'exec.final is "after-fix" and the tip moved by more than fix commits since the last verdict';
  return null;
}

/** The notes-fix rounds a lane has run and the most it may: `live`, the workflow file's `exec.noteRounds`
 *  as the caller read it now (field 84), else the route's (the preset's). */
export const notesBudget = (ledger, live) => ({
  used: ledger.rounds.filter((r) => r.notes).length,
  max: live ?? routeOf(ledger).noteRounds,
});

// A verified lane (PASS WITH NOTES, gate or close next) sends the builder back to fix the named notes; the
// round after it is the usual recheck by the verifier. A resolve verdict opens no notes round.
// A lane the notes cap holds takes one too once the cap is raised (field 84): the round ends the hold.
function onNotes(ledger, { notes, noteRounds, at }) {
  const verifier = verdicts(ledger).at(-1);
  const capped = capHeld(ledger);
  if (
    !capped &&
    (verifier?.verdict !== "PASS WITH NOTES" ||
      verifier.step === "resolve" ||
      !["gate", "close"].includes(ledger.next))
  )
    throw new Error(
      `notes can be fixed only after a PASS WITH NOTES verdict, before the lane closes (state ${ledger.state})`,
    );
  const { used, max } = notesBudget(ledger, noteRounds);
  if (used >= max)
    throw new Error(`${used} of ${max} notes rounds are used (exec.noteRounds is ${max})`);
  if (capped) {
    const { round: _n, ...kept } = ledger.hold;
    const note = `a notes round on ${notes.join(", ")}: exec.noteRounds is ${max} now`;
    ledger.holds = [...(ledger.holds ?? []), { ...kept, resumedAt: at, note, redo: false }];
    ledger.hold = undefined;
  }
  const builder = builders(ledger).at(-1);
  return send(
    ledger,
    "fix",
    { from: verifier.reportPath, agent: builder?.agent, notes },
    `the verifier's notes ${notes.join(", ")}`,
  );
}

// A verified lane: refused otherwise, naming the event.
function verified(ledger, what) {
  if (ledger.state !== "verified")
    throw new Error(`${what} is for a verified lane (state ${ledger.state}, next ${ledger.next})`);
  return ledger;
}

// A verified lane's branch goes back to its last builder, to be rebased onto main.
function onRebase(ledger) {
  verified(ledger, "a rebase");
  const builder = builders(ledger).at(-1);
  return send(
    ledger,
    "rebase",
    { from: builder?.reportPath, agent: builder?.agent },
    "rebase the branch onto main",
  );
}

// The owner sends a verified lane back with a change (field 77): one round for its last builder, recorded
// in `ownerFixes[]` with the round it went out as. The round's report goes on as any fix's (`routeBuilt`).
// A lane the notes cap holds for the owner goes back the same way, the change its answer in `holds[]`.
function onOwnerFix(ledger, { note, at }) {
  if (capHeld(ledger)) {
    const { round: _n, ...kept } = ledger.hold;
    ledger.holds = [...(ledger.holds ?? []), { ...kept, resumedAt: at, note, redo: false }];
    ledger.hold = undefined;
  } else if (ledger.state !== "verified" || !["close", "merge"].includes(ledger.next))
    throw new Error(
      `the owner's fix is for a verified lane (state ${ledger.state}, next ${ledger.next})`,
    );
  const builder = builders(ledger).at(-1);
  ledger.ownerFixes = [...(ledger.ownerFixes ?? []), { note, at, round: ledger.rounds.length + 1 }];
  return send(
    ledger,
    "fix",
    { from: builder?.reportPath, agent: builder?.agent, owner: { note, at } },
    "the owner's change",
  );
}

// After a rebase (reported, or found done): a resolution that changed the commits is read by a fresh
// verifier under `rebase: "recheck"`; else the gate checks the new tip.
function afterRebase(ledger, { tip, changed = true, gate = true, tier }) {
  if (changed && routeOf(ledger).rebase === "recheck")
    return send(
      ledger,
      "resolve",
      {},
      "the rebase changed the commits: a verifier reads the resolution",
    );
  const why = changed
    ? 'exec.rebase is "gate": the gate checks the rebased tip'
    : "the rebase changed no commit: the gate checks the new tip";
  return gateOrClose(ledger, tip, { gate, tier }, why);
}

// A lane closed with no verdict (the route skipped its verifier) gets one fresh verifier now.
function onReverify(ledger) {
  verified(ledger, "reverify");
  if (verdicts(ledger).length)
    throw new Error("reverify is for a lane closed without a verifier; a verifier closed this one");
  return send(ledger, "verify", {}, "a verifier reads the work the route sent past one");
}

/** The tip the lane's checks stand for: the last counted verdict's, else the last `builtTip` (a route
 *  with no verifier, a rebase), carried through each later `restacks[]` entry with resolution "none" whose
 *  `from` it is (a clean restack replays the same commits). A restack resolved by hand carries nothing. */
export function verifiedTip(ledger) {
  let tip = verdicts(ledger).at(-1)?.tip ?? ledger.rounds.findLast((r) => r.builtTip)?.builtTip;
  for (const r of ledger.restacks ?? [])
    if (tip !== undefined && r.resolution === "none" && r.from === tip) tip = r.to;
  return tip;
}

// A stacked lane's branch moved onto its parent's tip or main, with no agent out (the caller checks the
// git; the machine records it). Held: recorded, no change; the verifier after the build reads it all.
// Resolved by hand after a verdict: a fresh verifier reads the resolution; with no verdict (the route skipped
// the verifier) the gate decides, as it did for the build. Else the gate checks the new tip, which the checks
// stand for only when the restack replayed the very tip they cover: any other tip stops at the gate.
function onRestack(ledger, event) {
  const { from, to, base, onto, parent, resolution, gate = true, at, rangeDiff } = event;
  const held = ledger.state === "held";
  if (held && (ledger.hold?.for === "guard" || ["verified", "verdict"].includes(ledger.hold?.when)))
    throw new Error(
      `a restack waits for the lane's ${ledger.hold.for === "guard" ? "report after its guard trip" : ledger.hold.when === "verdict" ? "owner's answer at its notes cap" : "resume from its park"}`,
    );
  if (!held && !["gate", "close", "merge"].includes(ledger.next))
    throw new Error(
      `a restack waits for the lane's gate, close or merge, or a hold (state ${ledger.state}, next ${ledger.next})`,
    );
  // What the lane trusted before: the tip its gate or close was settled on.
  const trusted =
    (ledger.next === "gate" ? ledger.gateTip : ledger.closedTip) ?? verifiedTip(ledger);
  ledger.restacks = [
    ...(ledger.restacks ?? []),
    { at, parent, onto, from, to, base, resolution, ...(rangeDiff && { rangeDiff }) },
  ];
  ledger.base = base.to;
  if (onto === "main") ledger.on = undefined;
  if (held)
    return { ledger, next: ledger.next, reason: "held: the verifier after the build reads it all" };
  if (resolution === "by hand" && verdicts(ledger).length)
    return send(
      ledger,
      "resolve",
      {},
      "the restack was resolved by hand: a verifier reads the resolution",
    );
  const tip = resolution === "by hand" || from === trusted ? to : trusted;
  if (!gate)
    return settle(ledger, "close", "no gate in the workflow file: closes on the restack", tip);
  return settle(ledger, "gate", "restacked: the gate checks the new tip", tip);
}

function onGate(ledger, record) {
  ledger.gates.push(record);
  if (ledger.next !== "gate") return { ledger, next: ledger.next };
  // A red that failed only in listed flaky tests is re-run alone; the re-run's record decides.
  if (record.flakyRed?.length) return { ledger, next: ledger.next };
  // The tip the lane settled the gate on (a ledger from before `gateTip`: the tip its checks stand for).
  const verified = ledger.gateTip ?? verifiedTip(ledger);
  if (record.commit !== verified)
    return stop(ledger, `the branch moved from ${short(verified)} since the verdict`);
  if (!greenOn([record], verified))
    return stop(ledger, `the worktree gate is red (${gateWhy(record)})`);
  return settle(ledger, "close", "the worktree gate is green", verified);
}

const gateWhy = (r) =>
  r.exit !== 0 ? `exit ${r.exit}` : r.cleanAfter ? "not clean before" : "it left files behind";
const short = (sha) => (typeof sha === "string" ? sha.slice(0, 7) : String(sha));
