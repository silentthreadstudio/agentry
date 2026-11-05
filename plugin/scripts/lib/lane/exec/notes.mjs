// exec/notes — a verifier's `N<number>` notes: read from its report, judged by a recheck, sent back
// by a notes round or left as built, kept open on the ledger, and counted against `exec.noteRounds`.
import { readFileSync } from "node:fs";
import { unfenced } from "../../process/markdown.mjs";
import { resolveWorkflow } from "../../process/spec/presets.mjs";
import { withSection } from "../brief.mjs";
import { now } from "../fmt.mjs";
import { isAncestor } from "../land.mjs";
import { verdicts } from "../rounds.mjs";
import { git } from "../worktree.mjs";
import { readOr, refuse } from "./lane.mjs";

// The notes-round cap as the workflow file says now: read at each call, not fixed at start.
export const liveNotes = ({ spec }) => resolveWorkflow(spec).exec.noteRounds;

// The notes `verdict --leave` leaves as built: `[{ label, by, at, round }]`, each a note of this report
// (refused otherwise, before anything is written); none without --leave.
export function leftNotes({ leave, by }, text, round) {
  if (leave === null) return [];
  const labels = [...new Set(leave.split(",").map((n) => n.trim().toUpperCase()))];
  if (!labels.every((n) => /^N\d+$/.test(n)))
    refuse(`--leave takes the verifier's note labels, like N2,N9 (got ${leave})`);
  const found = notesOf(text);
  const missing = labels.filter((n) => !found.has(n));
  if (missing.length)
    refuse(
      `--leave: ${missing.join(", ")} not in the verifier's report ${round.reportPath} (it has ${[...found.keys()].join(", ") || "no N<number> notes"})`,
    );
  const at = now();
  return labels.map((label) => ({ label, by, at, round: round.n }));
}

// The label and text of each `N<number>` note in a verifier's report: a line that opens with its label.
export function notesOf(text) {
  const notes = new Map();
  for (const line of text.split("\n")) {
    const m = /^[\s>#*`_-]*(N\d+)\b[\s.:)\]*`_-]*(.*)$/.exec(line);
    if (m && !notes.has(m[1])) notes.set(m[1], m[2].trim());
  }
  return notes;
}

// A recheck's line for a note: `N1: PASS <evidence>` / `N1: FAIL …` at the start of a line (after an optional
// `- ` or `* `), any case. Prose ("N1 passes") is not one.
// A note's label, or `owner` for the owner's change.
const RECHECK_LINE = /^[ \t]*(?:[-*][ \t]+)?(N\d+|owner):[ \t]*(PASS|FAIL)\b/i;
// The lines of `text` outside a fenced block.
const prose = (text) => unfenced(text).split("\n");

/** Each label a recheck report judged: label → { pass, fail }, counting only `RECHECK_LINE`s outside a fence. */
function recheckLines(text) {
  const out = new Map();
  for (const line of prose(text)) {
    const m = RECHECK_LINE.exec(line);
    if (!m) continue;
    const label = m[1].toUpperCase();
    const seen = out.get(label) ?? { pass: false, fail: false };
    seen[m[2].toUpperCase() === "PASS" ? "pass" : "fail"] = true;
    out.set(label, seen);
  }
  return out;
}

// Does the recheck report `text` pass every label sent back: each has a PASS line and no FAIL line. None
// sent back is not covered.
export const coveredBy = (text, labels) => {
  const judged = recheckLines(text);
  return (
    labels.length > 0 &&
    labels.every((l) => judged.get(l.toUpperCase())?.pass && !judged.get(l.toUpperCase())?.fail)
  );
};

// The labels of the notes sent back since the last counted verdict: the ones a notes round picked, or every
// `N<k>` of a FAIL report, and `owner` after an owner's fix. None for a PASS with no such round since. A
// note that verdict left as built (`verdict --leave`) is never one.
export function sentBack(ledger) {
  const verdict = verdicts(ledger).at(-1);
  if (!verdict) return [];
  const kept = new Set(
    (ledger.left ?? []).filter((l) => l.round === verdict.n).map((l) => l.label),
  );
  return sentBackOf(ledger, verdict).filter((label) => !kept.has(label));
}
// Every label sent back since `verdict`, the ones it left included.
function sentBackOf(ledger, verdict) {
  const since = ledger.rounds.filter((r) => r.role === "build" && r.n > verdict.n);
  const picked = since.findLast((r) => r.notes);
  const notes = picked
    ? picked.notes
    : verdict.verdict === "FAIL"
      ? [...notesOf(readOr(verdict.reportPath)).keys()]
      : [];
  // The owner's change is one more note sent back: the recheck judges it as `owner: PASS|FAIL`.
  return since.some((r) => r.owner) ? [...notes, "owner"] : notes;
}

// Did the branch move from the last verdict's tip to `tip` by fix commits alone: that tip is an ancestor
// of this one and no merge commit lies between.
export function onlyFixCommits(root, from, tip) {
  if (!from || !isAncestor(root, from, tip)) return false;
  const merges = git(root, ["rev-list", "--merges", `${from}..${tip}`, "--"]);
  return merges.status === 0 && merges.stdout.trim() === "";
}

// The notes a verdict leaves open, `N1 <text>`: the report's own notes (its recheck lines left out) and,
// after a recheck, the earlier open notes it did not pass.
export function openNotesOf(text, round, earlier = []) {
  const judged = round.step === "recheck" ? recheckLines(text) : new Map();
  const own = [
    ...notesOf(
      prose(text)
        .filter((l) => !RECHECK_LINE.test(l))
        .join("\n"),
    ),
  ].map(([label, body]) => `${label} ${body}`.trimEnd());
  const label = (n) => n.split(" ", 1)[0];
  const kept =
    round.step === "recheck"
      ? earlier.filter((n) => {
          const j = judged.get(label(n));
          return !(j?.pass && !j.fail) && !own.some((o) => label(o) === label(n));
        })
      : [];
  return [...own, ...kept];
}

// The notes `found` (label → text) with each of the ledger's open notes (`N1 <text>`, kept from the report
// that raised it) it lacks.
export function withOpen(found, open = []) {
  const out = new Map(found);
  for (const note of open) {
    const [label, ...text] = note.split(" ");
    if (!out.has(label)) out.set(label, text.join(" "));
  }
  return out;
}

// `- N1: text` for each label, read from the verifier report at `path`, else from the open notes (an
// unreadable report gives bare labels).
export function noteLines(path, labels, open) {
  let found = new Map();
  try {
    found = notesOf(readFileSync(path, "utf8"));
  } catch {}
  found = withOpen(found, open);
  return labels.map((n) => `- ${n}: ${found.get(n) ?? ""}`.trimEnd()).join("\n");
}

// A notes-fix brief: the notes section goes in before the first of the brief's own sections.
export function withNotesToFix(text, { from, notes }, open) {
  const section = [
    "## Notes to fix",
    "",
    `The verifier passed this with notes (${from}). Fix exactly these, each with a committed test where it is behavior, and leave the other notes alone:`,
    "",
    noteLines(from, notes, open),
    "",
  ].join("\n");
  return withSection(text, section);
}
