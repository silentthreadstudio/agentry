// exec/briefs — the brief each round's agent reads: its template filled with the contract, the owned
// files, the cited decisions, recalled facts and the gate the round may read or must run, then the
// round added to the ledger; and a waiting brief written again when what it says has changed.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ledgers from "../../process/ledger.mjs";
import { gateOf } from "../../process/spec/workflow.mjs";
import { shellQuote as q } from "../../text/shell.mjs";
import { adoptedWork } from "../adopt.mjs";
import {
  appendedAfter,
  bullets,
  carriedWork,
  notesSection,
  ownerChange,
  policySlots,
  recheckSlots,
  renderBrief,
  stepReminder,
  stepSlots,
  stoppedRound,
  withSection,
} from "../brief.mjs";
import { citedDecisions } from "../decisions.mjs";
import { ownedMark } from "../exec-view.mjs";
import { now, short } from "../fmt.mjs";
import { changedSince, pickTier } from "../gate.mjs";
import { recalledFacts } from "../recall.mjs";
import { nextListOf } from "../report.mjs";
import { addRound, greenOn, verdicts } from "../rounds.mjs";
import { branchOf } from "../worktree.mjs";
import { headOf } from "./guard/snapshot.mjs";
import { contractFile, isFlagged, laneLine, ownedOf, readOr } from "./lane.mjs";
import { noteLines, sentBack, withNotesToFix } from "./notes.mjs";

function gateLine(root, spec, ledger) {
  if (!gateOf(spec)) return "none: the workflow file has no gate, so run the repo's own checks";
  return `cd ${q(ledger.worktree)} && ${laneLine(root, "gate", ledger.id)}`;
}

// The tier `role` runs in the lane's worktree: on the files the branch changed since its base, and the
// item's flag.
export const laneTier = (ctx, ledger, config, role) =>
  pickTier(config, role, {
    changed: changedSince(ledger.worktree, ledger.base, "HEAD") ?? [],
    flagged: isFlagged(ctx, ledger),
  });

// The tier the build role runs in the lane's worktree (a green record of it closes the lane), or undefined
// with no gate.
export const buildTier = (ctx, ledger) => {
  const config = gateOf(ctx.spec);
  return config ? (laneTier(ctx, ledger, config, "build").tier ?? undefined) : undefined;
};

// The gate part of a verify brief. A green record to read instead of re-running: the latest worktree gate
// run on this very tip and tree (a moved tip never matches), green on a clean tree, of the tier the verify
// (or build) role runs, with that tier's argv as the workflow file says it now. A red after a green is the
// latest, so it is not read. Without one, under `gate.roles.verify: "none"` the gate is not the verifier's
// (the lane runs the build tier after the verdict); else the brief carries the full gate line. The slots
// every brief is given.
function recordedGate(ctx, ledger, tip) {
  const { root, spec } = ctx;
  const config = gateOf(spec);
  const tree = headOf(root, `${tip}^{tree}`);
  const latest = (ledger.gates ?? []).findLast(
    (g) => g.where === "worktree" && g.commit === tip && (g.tree === undefined || g.tree === tree),
  );
  const buildOne = config ? laneTier(ctx, ledger, config, "build") : null;
  const build = buildOne?.tier ?? null;
  const tiers = config ? [laneTier(ctx, ledger, config, "verify"), buildOne] : [];
  const same = tiers.find((t) => t.tier && t.tier === latest?.tier);
  const argv = (c) => JSON.stringify(c ?? null);
  const record =
    latest && greenOn([latest], tip) && same && argv(latest.command) === argv(same.command)
      ? latest
      : null;
  const notYours = !record && config?.roles.verify === "none";
  return {
    gateGreen: !!record,
    gateNotYours: notYours,
    gateRun: !record && !notYours,
    buildTier: build ?? "",
    gateSha: record ? short(record.commit) : "",
    gateLog: record?.log ?? "",
  };
}

function factsLine(root, owned, block) {
  const { prime, facts } = recalledFacts(root, { owned, block });
  if (prime !== "all") return `none (memory.prime is "${prime}": briefs carry no recalled facts)`;
  return bullets(
    facts.map((f) => {
      const body = f.body.replace(/\s+/g, " ");
      return `[${f.type ?? "fact"} · ${f.id ?? "?"}] ${body.length > 600 ? `${body.slice(0, 599)}…` : body}`;
    }),
  );
}

// Render the brief for `dispatch` as round `n` and return the round's files.
export function brief({ root, spec, model }, ledger, dispatch) {
  const n = ledger.rounds.length + 1;
  const dir = ledgers.runDir(root, ledger.id);
  const name = `r${n}-${dispatch.step}`;
  const logDir = join(dir, "logs", `r${n}`);
  mkdirSync(logDir, { recursive: true });
  const block = readFileSync(contractFile(root, ledger.id), "utf8");
  const owned = ownedOf(root, ledger);
  const builder = ledger.rounds.filter((r) => r.role === "build").at(-1);
  const tip = headOf(root, ledger.branch);
  const fresh = !dispatch.resend;
  // The notes the conductor picked: a notes-fix round carries them, and so does the recheck after it.
  const picked =
    dispatch.step === "recheck" && fresh && builder?.notes
      ? builder
      : dispatch.step === "fix" && dispatch.notes
        ? dispatch
        : null;
  const values = {
    id: ledger.id,
    round: n,
    contract: `${ledger.contract.file}:${ledger.contract.line}`,
    block: block.trimEnd(),
    related: !!ledger.contract.related?.length,
    notes: notesSection(ledger.contract.related),
    owned: bullets(owned.map((o) => `\`${o.path}\`${ownedMark(o).slice(o.path.length)}`)),
    decisions: bullets(
      citedDecisions({ root, spec, model, block, task: ledger.id, cite: ledger.cite }).map(
        (d) => `${d.id}: ${d.text}`,
      ),
    ),
    facts: factsLine(
      root,
      owned.map((o) => o.path),
      block,
    ),
    worktree: ledger.worktree,
    cd: `cd ${q(ledger.worktree)}`,
    branch: ledger.branch,
    base: short(ledger.base),
    stacked: Boolean(ledger.on),
    on: ledger.on ?? "",
    mainRoot: root,
    logDir,
    reportPath: join(dir, `${name}.report.md`),
    gateLine: gateLine(root, spec, ledger),
    ...recordedGate({ root, spec, model }, ledger, tip),
    tip: short(tip),
    from: dispatch.from ?? "",
    reason: dispatch.reason ?? "",
    resend: !!dispatch.resend,
    recheck: dispatch.step === "recheck" && fresh,
    picked: !!picked,
    pickedNotes: picked ? noteLines(picked.from, picked.notes, ledger.openNotes) : "",
    fail: dispatch.step === "fix" && !dispatch.guard && !dispatch.notes && !dispatch.owner && fresh,
    guard: !!dispatch.guard && fresh,
    needed: dispatch.step === "needs-context" && fresh,
    builderReport: builder?.reportPath ?? "none",
    earlier: verdicts(ledger)
      .map((r) => r.reportPath)
      .join(", "),
    ...policySlots(spec, dispatch.step),
    ...recheckSlots({ sentBack: sentBack(ledger), ...lastMove(ledger) }),
    ...stepSlots({
      steps: ledger.steps,
      stepRun: dispatch.stepRun,
      holds: ledger.holds,
      step: dispatch.step,
      fresh,
      mode: dispatch.mode,
    }),
  };
  // The owner's change: in its fix round's brief, and the recheck's after it.
  const owner =
    dispatch.step === "fix"
      ? dispatch.owner
      : dispatch.step === "recheck" && fresh
        ? builder?.owner
        : null;
  const file = join(dir, `${name}.md`);
  let text = renderBrief(dispatch.step, values);
  if (dispatch.step === "fix" && picked) text = withNotesToFix(text, picked, ledger.openNotes);
  // A builder answered with the fact it asked for is told which step it is on, and what finishes it.
  if (dispatch.step === "needs-context" && fresh) {
    const reminder = stepReminder({ steps: ledger.steps, stepRun: dispatch.stepRun });
    if (reminder) text = withSection(text, reminder);
  }
  // A fresh builder sent on after `resume --fresh` is told where the one before it stopped.
  if (dispatch.stopped && fresh)
    text = withSection(
      text,
      stoppedRound({ report: dispatch.stopped, next: nextListOf(readOr(dispatch.stopped)) }),
    );
  if (owner)
    text = withSection(text, ownerChange(owner, dispatch.step === "fix" ? "build" : "verify"));
  // A restarted lane's first brief says what was carried into the tree.
  // A resolve check of a verified carry judges the range-diff, not the old builder's report.
  if (n === 1 && fresh && ledger.carried && dispatch.step !== "resolve")
    text = withSection(text, carriedWork({ ...ledger.carried, note: ledger.restarted?.note }));
  // The old lane's last verdict, when its verifier failed the work: the report to read first.
  if (n === 1 && fresh && ledger.carried?.verdict)
    text = withSection(
      text,
      `## The last verdict\n\nThe old lane's verifier returned ${ledger.carried.verdict.verdict}. Its report is ${ledger.carried.verdict.report}: read it and fix what it names.\n`,
    );
  // An adopted lane's first brief lists the commits it took in.
  if (n === 1 && fresh && ledger.adopted) text = withSection(text, adoptedWork(ledger.adopted));
  // The fact the owner supplied at a context hold goes where the conductor puts one: at the end.
  if (dispatch.fact) text = `${text.trimEnd()}\n\n## The fact\n\n${dispatch.fact}\n`;
  writeFileSync(file, text);
  return { brief: file, reportPath: values.reportPath, tip, at: now() };
}

// What a resolve check reads: the range-diff of the branch's newest move and the branch it moved onto. The
// last rebase onto main, or a restack resolved by hand (onto its parent's branch or main), whichever is later.
function lastMove(ledger) {
  const rebase = ledger.rebases?.at(-1);
  const restack = ledger.restacks?.findLast((r) => r.rangeDiff);
  if (restack && !(rebase?.at > restack.at))
    return {
      mainBranch: restack.onto === "main" ? ledger.mainBranch : branchOf(restack.parent),
      rangeDiff: restack.rangeDiff,
    };
  return { mainBranch: ledger.mainBranch, rangeDiff: rebase?.rangeDiff ?? "" };
}

export const dispatchNext = (ctx, ledger, dispatch) =>
  dispatch ? addRound(ledger, dispatch, brief(ctx, ledger, dispatch)) : ledger;

// A verifier's brief that is waiting is written again from its template, so a gate that went green on its
// tip since is read, not re-run, and one that went red after it is run again. What the conductor
// appended after the last section is put back.
export function refreshBrief(ctx, ledger) {
  const round = ledger.rounds.at(-1);
  const old = readFileSync(round.brief, "utf8");
  brief(ctx, { ...ledger, rounds: ledger.rounds.slice(0, -1) }, round);
  const kept = appendedAfter(old, readFileSync(round.brief, "utf8"));
  if (kept) appendFileSync(round.brief, kept);
  return round.brief;
}
