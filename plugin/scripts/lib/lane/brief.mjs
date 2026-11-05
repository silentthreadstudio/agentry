// brief — what an exec round's brief says, rendered from the templates in the conducting skill's
// `references/briefs/` (ADR-R3): the same brief every time, on disk, quoting the board instead of memory.
// The owns clause is read by `owns.mjs`, the decisions quoted by `decisions.mjs`, the facts recalled by
// `recall.mjs` and the builder suggested by `builder.mjs`; this module fills the templates.
//
//   relatedNotes    the lines elsewhere that mention the task (amendments), read verbatim with file:line
//   notesSection    those notes as the brief's "Later notes" lines, capped at `NOTES_CAP`
//   appendedAfter   what a brief holds after its last template section (a section the conductor added),
//                   so a rewrite of the brief can put it back
//   slotsOf, fill   the slots a template uses, and a template filled from its values
//   renderBrief     a template filled; every `{{slot}}` must be given, so a template can't drift silently
//   policySlots     the repo's policy lines (workflow file `briefs`) for a dispatch, as the brief's section
//   rewordSlots     the rebase brief's Reword list: each commit the land would pick that breaks the
//                   workflow file's `commits` rules (`policySlots` carries the rules to it)
//   recheckSlots    what a recheck, rebase and resolve brief name: the notes sent back, main's branch and
//                   the range-diff the resolve check reads
//   stepSlots       the slots a contract with steps fills: the round's run, the owner's answer a
//                   `continue` round carries, the approvals a verifier is told of (all off without steps)
//   stepReminder    the `## Your step` section of a builder round sent back on a run of steps
//   withSection     a rendered brief with a section put in before its first `## ` section
//   ownerChange     the owner's change a verified lane was sent back with, as a builder's or verifier's section
//   carriedWork     the `## Carried work` section of a restarted lane's first build brief
//   bullets         a list as brief lines
//
// Reads the board's files, the templates and (for a rebase) the lane's commits; writes nothing. Node
// built-ins only.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readInside } from "../process/read.mjs";
import { own } from "../process/spec/shape.mjs";
import { runText } from "../process/steps.mjs";
import { shellWord } from "../text/shell.mjs";
import { answerLine } from "./exec-view.mjs";
import { toLand } from "./land.mjs";
import { checkCommits, readCommits, rulesOf } from "./subjects.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEMPLATES = join(
  HERE,
  "..",
  "..",
  "..",
  "skills",
  "conducting",
  "references",
  "briefs",
);

// The template each dispatch step renders.
const TEMPLATE_OF = {
  build: "build",
  fix: "fix",
  "needs-context": "fix",
  continue: "fix",
  rebase: "rebase",
  verify: "verify",
  recheck: "verify",
  final: "final",
  resolve: "resolve",
};

/** The text of each `related` hit (`{ file, line }`, `file` relative to `root`) as `{ at, text }`, `at`
 *  its `file:line`. A hit whose line can't be read inside the repo is left out. */
export function relatedNotes(root, related) {
  const out = [];
  for (const { file, line } of related ?? []) {
    const text = readInside(root, join(root, file))?.split(/\r?\n/)[line - 1]?.trim();
    if (text) out.push({ at: `${file}:${line}`, text });
  }
  return out;
}

export const NOTES_CAP = 8;
const NOTE_WIDTH = 400;

/** The notes as brief lines (`- file:line: text`), at most `NOTES_CAP`, each line cut at `NOTE_WIDTH`
 *  characters; a final line says how many were left out. Empty for no notes. */
export function notesSection(notes) {
  const lines = (notes ?? []).slice(0, NOTES_CAP).map(({ at, text }) => {
    const cut = text.length > NOTE_WIDTH ? `${text.slice(0, NOTE_WIDTH - 1)}… (cut)` : text;
    return `- ${at}: ${cut}`;
  });
  const more = (notes?.length ?? 0) - NOTES_CAP;
  if (more > 0)
    lines.push(
      `- (capped at ${NOTES_CAP}: ${more} more not shown; run \`board contract\` for all)`,
    );
  return lines.join("\n");
}

/** What `old` (a brief as it was on disk) holds after the last section of `fresh` (the same brief
 *  rendered again): a section someone appended at the end. The last section's heading is looked for in
 *  `old`, taking the place where the rendered section matches in full. Empty when there is nothing
 *  after it, or the old brief does not match the template. */
export function appendedAfter(old, fresh) {
  const headings = [...fresh.matchAll(/^## .*$/gm)];
  const last = headings.at(-1);
  if (!last) return "";
  const section = fresh.slice(last.index).trimEnd();
  for (let at = old.indexOf(last[0]); at >= 0; at = old.indexOf(last[0], at + 1))
    if (old.startsWith(section, at))
      return old.slice(at + section.length).trim() ? old.slice(at + section.length) : "";
  return "";
}

/** The slots and section names a template uses, in order of first use. */
export const slotsOf = (template) => [
  ...new Set([...template.matchAll(/\{\{[#/]?(\w+)\}\}/g)].map((m) => m[1])),
];

const SECTION = /^\{\{#(\w+)\}\}\n([\s\S]*?)^\{\{\/\1\}\}\n?/gm;

/** `template` with every `{{slot}}` filled from `values`. A section `{{#name}}` … `{{/name}}` (each
 *  marker on its own line) is kept only when `values[name]` is truthy. A slot or section without a
 *  value is an error, never left blank. A line that is only a slot whose value is empty goes, with the
 *  blank line after it, so an absent part leaves no gap; the values themselves are put in as given. */
export function fill(template, values) {
  const missing = slotsOf(template).filter((s) => !Object.hasOwn(values, s));
  if (missing.length) throw new Error(`brief slots without a value: ${missing.join(", ")}`);
  const lines = template
    .replace(SECTION, (_, name, body) => (values[name] ? body : ""))
    .split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const only = /^\{\{(\w+)\}\}$/.exec(lines[i].trim());
    if (only && String(values[only[1]]) === "") {
      if (lines[i + 1]?.trim() === "") i++;
      continue;
    }
    kept.push(lines[i]);
  }
  return `${kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\{\{(\w+)\}\}/g, (_, s) => String(values[s]))
    .trimEnd()}\n`;
}

// A fix round's brief wraps the build brief, a final round's the verify brief: each rule is written once.
const WRAPS = { fix: "build", final: "verify" };
const read = (name) => readFileSync(join(TEMPLATES, `${name}.md`), "utf8");
const body = (text) => text.replace(/^# .*\n+/, "");

/** The brief for dispatch `step`, rendered from its template (with the brief it wraps as `{{inner}}`). */
export function renderBrief(step, values) {
  const name = Object.hasOwn(TEMPLATE_OF, step) ? TEMPLATE_OF[step] : null;
  if (!name) throw new Error(`no brief template for step "${step}"`);
  const inner = Object.hasOwn(WRAPS, name) ? body(fill(read(WRAPS[name]), values)) : "";
  const own = name === "rebase" ? { ...rewordSlots(values), ...values } : values;
  return fill(read(name), { ...own, inner });
}

/** The repo-policy slots for dispatch `step`: the workflow file's `briefs` list for its role (`build` for a
 *  builder's step, the rebase included; `verify` for a verifier's, the resolve check included), each line a
 *  bullet, printed as written. No list, no section.
 *  With the workflow file's `locks`, the time-limit rule's lock line (`locked`): `lockTake` is the take
 *  command, the lock named when there is one, else `<name>` and the names.
 *  For a rebase, `commitRules` too: the workflow file's `commits` (or null), which `rewordSlots` reads. */
export function policySlots(spec, step) {
  const name = Object.hasOwn(TEMPLATE_OF, step) ? TEMPLATE_OF[step] : null;
  const role = ["build", "fix", "rebase"].includes(name) ? "build" : "verify";
  const lines = own(own(spec, "briefs"), role) ?? [];
  const locks = Object.keys(own(spec, "locks") ?? {});
  const lockTake =
    locks.length === 1
      ? `\`agentry lock take ${locks[0]}\``
      : `\`agentry lock take <name>\` (${locks.join(", ")})`;
  return {
    policy: lines.length > 0,
    policyLines: bullets(lines),
    locked: locks.length > 0,
    lockTake: locks.length ? lockTake : "",
    ...(name === "rebase" && { commitRules: rulesOf(spec) }),
  };
}

/** The rebase brief's Reword slots (field 92): the commits the land would pick (`branch` past
 *  `mainBranch`, in `mainRoot`) that break `commitRules` (the workflow file's `commits`), one
 *  `- reword <short sha> "<subject>": <why>` line each in `rewordLines`; `reword` turns the section on and
 *  `rewordExcept` lets rule 3 name it. A commit git cannot read is the land's to report, never listed.
 *  No rules or no broken commit: every slot off, so the brief reads as without them. */
export function rewordSlots({ commitRules, mainRoot, branch, mainBranch }) {
  const plan = commitRules ? toLand(mainRoot, { main: mainBranch, branch }) : null;
  const commits = plan && !plan.error ? readCommits(mainRoot, plan.picks) : [];
  const broken = checkCommits(
    commitRules ?? {},
    commits.filter((c) => c.failed === undefined),
  );
  return {
    reword: broken.length > 0,
    rewordExcept: broken.length > 0 ? ", except the ones listed under Reword" : "",
    rewordLines: broken
      .map((c) => `- reword ${c.sha.slice(0, 7)} "${c.subject}": ${c.why}`)
      .join("\n"),
  };
}

/** The slots a recheck, rebase and resolve brief fill: `sentBack` the labels of the notes sent back (the
 *  picked ones, or every `N<k>` of the FAIL report), `mainBranch`, and `rangeDiff` the range-diff file the
 *  resolve check judges ("" when there is none). */
export const recheckSlots = ({ sentBack = [], mainBranch = "main", rangeDiff = "" } = {}) => ({
  sentBack: sentBack.length ? sentBack.join(", ") : "none: your report labelled no note",
  mainBranch,
  rangeDiff,
});

const NOT_THIS_ROUND_WIDTH = 100;

// A step's fresh builder (not a resumed one) is pointed to the report the step before it ended with.
const newBuilder = ({ evidence }, mode) =>
  mode === "resume" || !evidence
    ? ""
    : ` The step before it ended with the report ${evidence}: if you are new to this lane, read it first.`;

/** The slots of a contract built in steps (`process/steps.mjs`) for dispatch `step` on run `stepRun`
 *  (`[a, g]`), with the owner's answers so far (`holds`, the ledger's). A lane without steps gets every
 *  section off. `fresh` is false for a resent round, which carries no new section; `mode` the round's
 *  ("resume" keeps the pointer to the last step's report off: that builder wrote it). */
export function stepSlots({ steps = [], stepRun = null, holds = [], step, fresh = true, mode }) {
  const total = steps.length;
  const run = total && stepRun ? steps.slice(stepRun[0] - 1, stepRun[1]) : [];
  const later = run.length ? steps.slice(stepRun[1]) : [];
  const accept = run.flatMap((s) => s.accept);
  const cut = (t) => (t.length > NOT_THIS_ROUND_WIDTH ? `${t.slice(0, NOT_THIS_ROUND_WIDTH)}…` : t);
  const answer = step === "continue" && fresh ? holds.at(-1) : null;
  const approvals = holds.filter((h) => h.for === "owner" && h.when === "after" && !h.redo);
  return {
    stepped: run.length > 0,
    thisRun: run.length ? runText(stepRun, total) : "",
    runSteps: run.map((s) => `${s.n}. ${s.text}`).join("\n"),
    runAccept: accept.length
      ? bullets(accept)
      : "the step's own text above; the whole acceptance is checked after the last step",
    builtBefore:
      run.length && stepRun[0] > 1
        ? `Built before this round (on the branch): ${stepRun[0] === 2 ? "step 1" : `steps 1–${stepRun[0] - 1}`}.`
        : "",
    notThisRound: later.length
      ? later.map((s) => `step ${s.n}: ${cut(s.text)}`).join("; ")
      : "none: the verifier then reads the whole contract",
    ownerGate: run.at(-1)?.gate === "owner",
    noted: !!answer,
    answer: answer ? `"${answer.note}" (${answer.resumedAt})` : "",
    answerNext: !answer
      ? ""
      : answer.redo
        ? "Rework the same steps to that answer; the lane holds for the owner again when you report."
        : answer.when === "after"
          ? `Go on to the steps below.${newBuilder(answer, mode)}`
          : "Carry on with the same steps, to that answer.",
    // A lane parked mid-round may hold uncommitted work; one parked at a run's end does not.
    parked: answer?.for === "later" && answer.when === "during",
    approved: approvals.length > 0,
    approvals: approvals.map((h) => `- ${answerLine(h, total)}`).join("\n"),
  };
}

/** The `## Your step` section of a builder round sent back on a run of a contract's steps (a context
 *  answer): the step the round is on, and that it is done only when its own work is. "" with no steps. */
export function stepReminder({ steps = [], stepRun = null }) {
  const run = steps.length && stepRun ? steps.slice(stepRun[0] - 1, stepRun[1]) : [];
  if (!run.length) return "";
  const what = run.map((s) => s.text).join("; ");
  return [
    "## Your step",
    "",
    `You are on ${runText(stepRun, steps.length)}: ${what}`,
    "",
    "The step is done only when its own work is on the branch: a test or a fix for something else does not finish it. Report DONE for it only then.",
    "",
  ].join("\n");
}

/** `text` (a rendered brief) with `section` put in before its first `## ` section, or at the end. */
export function withSection(text, section) {
  const at = text.indexOf("\n## ");
  return at === -1
    ? `${text}\n${section}`
    : `${text.slice(0, at + 1)}${section}\n${text.slice(at + 1)}`;
}

/** The `## The owner's change` section (field 77): the owner's words quoted with their time, and for
 *  `role` "build" what to do with them, for "verify" how to judge the round that made them. */
export function ownerChange({ note, at }, role) {
  const quoted = String(note)
    .split(/\r?\n/)
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
  const what =
    role === "build"
      ? "Make exactly that change, each behavior with a committed test, and leave the rest of the work as it is."
      : "The builder's round you check made that change: judge it as the owner's call, and the rest against the contract. Write one line for it in your report, outside any code block: `owner: PASS <evidence>` or `owner: FAIL <evidence>`.";
  return [
    "## The owner's change",
    "",
    `The owner sent the verified lane back at ${at}:`,
    "",
    quoted,
    "",
    what,
    "",
  ].join("\n");
}

/** The `## Carried work` section of a restarted lane's first build brief (field 69): what `exec restart
 *  --carry` put in the tree (`{ commits, files, report, applied?, diff?, conflict? }`, the ledger's
 *  `carried`; `applied` whether the uncommitted diff is in the tree yet). A carry that
 *  stopped names its conflict, to resolve first. */
export function carriedWork({ commits, files, report, conflict, applied = true, diff }) {
  const last = report ? `Its last report is ${report}: read it first.` : "It left no report.";
  // Applied only when the carry got that far: a pick that stopped leaves the diff still to apply. The step
  // is named once: in the stop when it names it, else here.
  const apply = diff && `git apply --3way ${shellWord(diff)}`;
  const named = Boolean(apply) && String(conflict ?? "").includes(apply);
  const staged = !files
    ? ""
    : applied
      ? " Its uncommitted changes are applied staged (`git apply --3way` stages them): `git diff --cached` shows them."
      : named
        ? " Its uncommitted changes are not in the tree yet."
        : ` Its uncommitted changes are not in the tree yet: once the pick is done, apply them with \`${apply}\`.`;
  const stop = conflict ? ` Resolve this first: ${conflict}.` : "";
  return [
    "## Carried work",
    "",
    `A previous builder's work is in the tree (${commits} commits, ${files} files uncommitted). ${last}${staged}${stop}`,
    "",
  ].join("\n");
}

/** A list as brief lines (`- item`), or `none`. */
export const bullets = (items) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "none");
