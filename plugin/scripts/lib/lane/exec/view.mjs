// exec/view — what a step prints: the one JSON object every step returns (the next step, the prompt,
// brief and dispatch of an agent round, how a held or stopped lane goes on), from the ledger and the
// workflow file as they are now. Its text form, and the words for holds and idle lanes, are in the
// library's `../exec-view.mjs`.
import { basename, join } from "node:path";
import { prefix } from "../../cli/invoke.mjs";
import * as ledgers from "../../process/ledger.mjs";
import { workflowPathOf } from "../../process/read.mjs";
import { modelFor } from "../../process/spec/models.mjs";
import { resolveWorkflow } from "../../process/spec/presets.mjs";
import { shellQuote as q } from "../../text/shell.mjs";
import { suggestBuilder } from "../brief.mjs";
import { answerText, heldText, routeText } from "../exec-view.mjs";
import { DISPATCHES, expects, routeOf } from "../rounds.mjs";
import { stackOf } from "../stack.mjs";
import { ownsPath } from "./guard/allow.mjs";
import {
  LANE,
  contractFile,
  isFile,
  isFlagged,
  laneLine,
  leaves,
  normalised,
  ownedOf,
  readOr,
} from "./lane.mjs";

// The text's `model:` line names its source: `model: opus (contract)` (field 73).
export function withModelSource({ modelFrom, ...shown }) {
  return modelFrom ? { ...shown, model: `${shown.model} (${modelFrom})` } : shown;
}

// The steps of a contract, one line each: `1. <text> → owner OK`.
export const stepLines = (steps) =>
  steps.map((s) => `${s.n}. ${s.text}${s.gate === "owner" ? " → owner OK" : ""}`).join("\n");
export const stepCount = (ledger) => ledger.steps?.length ?? 0;

// The held line, and an owner's answer after its label: a parked verified lane's say so.
const heldLine = (hold, total) =>
  hold.when === "verified"
    ? `parked, verified, since ${hold.since}${hold.why ? `: "${hold.why}"` : ""}`
    : heldText(hold, total);
export const answerOf = (h, total) =>
  h.when === "verified"
    ? `verified at ${h.resumedAt}: "${h.note}"`
    : h.when === "verdict"
      ? `at the notes cap at ${h.resumedAt}: "${h.note}"`
      : answerText(h, total);

// The paths a NEEDS_CONTEXT report names that the lane does not own, in its first 20 lines: those of each
// `needs: <path>` line and each backticked path (a word with a `/` or a file extension, no spaces). A
// backticked word with no `/` counts only when it is a file in the worktree (`exec.noteRounds`, `e.g` are
// not), and a path that leaves the repository never does, nor a word starting with `-` (the hint would
// read as a flag).
const PATHISH = /^[\w.@][\w.@/-]*(?:\/[\w.@-]*|\.[A-Za-z][A-Za-z0-9]*)$/;
const trimmed = (w) => w.replace(/^`+|[`.,;:)]+$/g, "");
function namedOutside(root, ledger, reportPath) {
  const lines = readOr(reportPath).split("\n").slice(0, 20);
  const named = lines.flatMap((line) => {
    const needs = /^[\s>*_-]*needs\s*:\s*(.+)$/i.exec(line);
    const words = needs ? needs[1].split(/[\s,]+/).map(trimmed) : [];
    const ticked = [...line.matchAll(/`([^`\s]+)`/g)]
      .map((m) => trimmed(m[1]))
      .filter((w) => w.includes("/") || isFile(join(ledger.worktree, w)));
    return [...words, ...ticked];
  });
  const owned = ownedOf(root, ledger).map((o) => o.path);
  const mine = (p) => owned.some((o) => ownsPath(o, p) || ownsPath(p, o));
  const kept = (p) => PATHISH.test(p) && !/^\.+$/.test(p) && !leaves(p) && !mine(p);
  return [...new Set(named.map(normalised).filter(kept))];
}

// The way to let the builder touch the paths it asked for, when its report names any outside owns.
const ownsHint = (root, ledger, reportPath) => {
  const paths = namedOutside(root, ledger, reportPath);
  return paths.length
    ? `; or let it touch them: ${laneLine(root, "owns", ledger.id, ` --add ${paths.join(",")} --apply`)}, then resume`
    : "";
};

// What a held lane prints right after the header: the hold, and the step that answers it. A guard hold
// is answered by fixing main and reporting again; its `hold` goes with it (the saved report, the reason).
// A context hold by the owner's fact (or more owned files); a notes-cap hold by the owner's OK or change.
function heldLead(root, ledger) {
  const { hold } = ledger;
  if (ledger.state !== "held" || !hold) return {};
  if (hold.for === "context") {
    const run = laneLine(root, "resume", ledger.id, ' --note "<the fact>"');
    return {
      held: `the builder needs more context again → supply it: ${run}${ownsHint(root, ledger, hold.report)}; or start it again with its work: ${laneLine(root, "restart", ledger.id, " --carry")}`,
      asks: `${hold.reason} (${hold.report}), since ${hold.since}`,
      run,
    };
  }
  if (hold.for === "blocked") {
    const run = laneLine(root, "resume", ledger.id, ' --note "<what changed>"');
    return {
      held: `blocked: ${hold.reason} → clear it, then ${run} (the same round goes again; --same keeps the builder) · report ${hold.report}`,
      run,
    };
  }
  if (hold.when === "verdict") {
    const run = laneLine(root, "resume", ledger.id, ' --note "<the OK>"');
    return {
      held: `for the owner: ${hold.reason}, since ${hold.since} · evidence ${hold.evidence} → close it as is: ${run}, or send it back on your word: ${laneLine(root, "fix", ledger.id, ' --owner "<the change>"')}`,
      run,
    };
  }
  if (hold.for === "guard") {
    const again = laneLine(root, "report", ledger.id);
    return {
      held: `${heldText(hold)} → fix it (commit it between lanes, or add the path to guard.allow), then run ${again} again`,
      hold,
      run: again,
    };
  }
  return {
    held: heldLine(hold, stepCount(ledger)),
    run: laneLine(root, "resume", ledger.id, ' --note "<the OK>"'),
  };
}

// What a stacked lane prints next (after a hold's lines): `stack: on T1 at abc1234`, with what is due.
const stackLead = (root, ledger) =>
  ledger.on ? { stack: stackOf(root, ledger, ledgers.list(root)).line } : {};

export function view(ctx, ledger, { step, guards = [], nested = [], lead = {}, extra = {} }) {
  const { root, spec, model } = ctx;
  const round = ledger.rounds.at(-1);
  const out = {
    id: ledger.id,
    step,
    next: ledger.next,
    state: ledger.state,
    ...heldLead(root, ledger),
    ...stackLead(root, ledger),
    ...lead,
    reportPath: round?.reportPath ?? null,
    worktree: ledger.worktree,
    branch: ledger.branch,
    guards,
    nested,
  };
  const waiting = expects(ledger);
  if (DISPATCHES.includes(ledger.next) && (waiting === "report" || waiting === "verdict")) {
    out.prompt = [
      `agentry-task: ${ledger.id} role=${round.role} round=${round.n}`,
      `Read your brief first: ${round.brief}. Work only in ${ledger.worktree}; prefix every shell command with \`cd ${q(ledger.worktree)} &&\`.`,
    ].join("\n");
    out.brief = round.brief;
    out.role = round.role;
    out.mode = round.mode === "resume" && round.agent ? "resume" : "fresh";
    if (out.mode === "resume") out.agent = round.agent;
    const owned = ownedOf(root, ledger).map((o) => o.path);
    // The run's step markers, then the contract's bullets, name the builder and its model (field 96).
    const marks = {
      contract: readOr(contractFile(root, ledger.id)),
      steps: ledger.steps ?? [],
      stepRun: round.stepRun ?? null,
    };
    const builder = suggestBuilder(owned, marks);
    out.dispatch = round.role === "verify" ? { agent: "verifier" } : builder;
    const picked = modelFor(spec, round.role, {
      flagged: isFlagged(ctx, ledger),
      ui: builder.agent === "designer",
      owned,
      ...marks,
    });
    // `model` is the name a dispatch passes on; `modelFrom` where it came from (the text joins them).
    if (picked) Object.assign(out, { model: picked.model, modelFrom: picked.from });
    // The owner's fact from a context hold is in the brief already.
    if (round.step === "needs-context" && !round.resend && !round.fact)
      out.todo = `append the fact under "## The fact" at the end of ${round.brief} before sending it; if the contract, the repo and memory don't hold it, ask the owner first${ownsHint(root, ledger, round.from)}`;
    out.after = `${laneLine(root, waiting, ledger.id)} --agent <the agent's id>`;
  } else if (ledger.next === "gate" || ledger.next === "close") {
    out.run = laneLine(root, ledger.next, ledger.id);
  } else if (ledger.next === "merge") {
    out.run = `/agentry:merge ${ledger.id}`;
  }
  if (ledger.next === "stop") out.reason = ledger.stopReason ?? null;
  return {
    exit: ledger.next === "stop" ? 1 : 0,
    out: JSON.stringify({ ...out, ...extra }, null, 2),
  };
}

// The verify route the lane runs, and what the workflow file says now when that differs: the route is
// fixed at start (field 59), so a task flagged or a route changed since needs `reverify`.
export function routeNow(ctx, ledger) {
  const now = resolveWorkflow(ctx.spec).exec.verify;
  const was = routeOf(ledger).verify;
  if (now === was) return routeText(ledger.route);
  const file = basename(
    workflowPathOf(ctx.processPath ?? join(ctx.root, ".agentry", "process.json")),
  );
  return `${was} (fixed at start; ${file} now says ${now})`;
}

// A stopped lane's ways on (field 75): land it as it is, or start it again with its work.
export const waysOn = (root, ledger) => ({
  stopped: ledger.stopReason ?? "unknown",
  "ways on": `${prefix("lane", `node ${q(LANE)}`)} merge ${ledger.id} --branch ${ledger.branch ?? `agentry/${ledger.id}`} --root ${q(root)} (lands as is, the owner's call) · ${laneLine(root, "restart", ledger.id, " --carry")} (starts it again with its work)`,
});
