// lane session <start|close> [--json] — the opening and the ending of a session.
//
//   start   what the conductor needs once, in one object: the conductor prompt's path, the mode, the held
//           and idle lanes, the derived status (nudges and pending drafts included), recall ranked against the
//           work in flight, the owner's open questions, the lane ledgers, how many merged today, and the
//           vendored CLI's staleness as the main checkout's stamp says (`process/lanes.mjs`' vendored(), the
//           row `board explain` shows). Printed
//           as at most 40 lines, or `--json`. It records two things in the main checkout's `.agentry/run/`,
//           the same with `--json` or without: the Now a note was first read under (`note-seen.json`,
//           `stale-status.mjs`) and, per idle lane, the `lastChange` it asked the owner about
//           (`idle-asked.json`, `../session-checks.mjs`), so the owner is asked once. A newly idle lane is
//           recorded only when the text keeps the question line within its 40 lines.
//   close   what the ending walks through: the pending drafts, what `board fix` would write, the ledgers, what
//           `lane sweep --apply` would clean, the disk, the episodes nobody wrote, the owner's calls not
//           written down (`../owner-calls.mjs`) and the note. Always JSON.
//
//   <start|close> --check <skill>=pass|fail [--note <t>]
//           records one session check (`extensions.start.checks` / `extensions.close.checks`) in
//           `session-checks.jsonl` (`../session-checks.mjs`).
//
// Besides start's two records, without `--check` it only reads: board fix, the drafts and the sweep each do
// their own writing, when the command says so. The mode comes from the config reader (`mode` in `.agentry/config.json`) and is never
// interpreted here. With checks named, start and close carry `checks: { start, close }` (a View each).
// Exit 0, or 2 for a usage error.
//
// run(argv, { root, spec, model }) -> { exit, out }
import { basename, join, relative } from "node:path";
import { refuse, usageError } from "../../cli/help.mjs";
import { nextStep } from "../../cli/invoke.mjs";
import { readConfig } from "../../config.mjs";
import { run as fix } from "../../process/cli/fix.mjs";
import * as drafts from "../../process/drafts.mjs";
import { mainRoot } from "../../process/git.mjs";
import { vendored } from "../../process/lanes.mjs";
import * as ledgers from "../../process/ledger.mjs";
import { fit } from "../../process/render.mjs";
import { SKILL_DIR, sessionChecks, skillExists } from "../../process/spec/extensions.mjs";
import { idleMinutes } from "../../process/spec/presets.mjs";
import { markNoteSeen } from "../../process/stale-status.mjs";
import { noteView, statusView, titleOf, workKind } from "../../process/status.mjs";
import { runText } from "../../process/steps.mjs";
import { shellQuote } from "../../text/shell.mjs";
import { clock, heldText, idleHead } from "../exec-view.mjs";
import { gateLockDir, heldSlots } from "../gate-lock.mjs";
import { idleOf } from "../idle.mjs";
import { callLines, openCalls } from "../owner-calls.mjs";
import { conductorFacts } from "../recall.mjs";
import * as sessionChecksFile from "../session-checks.mjs";
import { stackOf } from "../stack.mjs";
import { leftovers, plan } from "../sweep.mjs";

export const help = {
  usage: [
    "session <start|close> [--json]",
    "session <start|close> --check <skill>=pass|fail [--note <t>]",
  ],
  purpose:
    "What opening or ending a session needs, in one read (start keeps its note and idle records); or record one of its repo checks.",
  args: {
    start: "prompt, mode, status, recall, open questions, lanes (40 lines, or --json)",
    close: "drafts, the board fix plan, ledgers, the sweep plan, pending episodes (always JSON)",
  },
  flags: {
    "--json":
      "print start as one JSON object (close always is); with --check, the entry and the counts",
    "--check <skill>=pass|fail":
      "record one check named in extensions.start.checks or extensions.close.checks",
    "--note <t>": "with --check: one line on why",
  },
  exits: { 0: "printed or recorded", 2: "usage, a refused check, or a process file it cannot use" },
  example: "lane session start",
};
const WIDTH = 80;
const MAX_LINES = 40;
const MAX_LIST = 4; // lines one list may take
const NOTE_LINES = 3; // lines of the note that start prints
const MAX_HELD = 3; // held and parked lanes start prints, the rest counted
const MAX_IDLE = 3; // newly idle lanes start prints a block for, the rest counted
const NOTE_COLUMNS = 100; // a failed close check's line, note included, as start prints it
const MAX_FAILED = 3; // failed close checks start names, the rest counted
const MAX_MISSING = 3; // named start checks with no SKILL.md start names, the rest counted
const QUESTION = "ask the owner once: park "; // the idle question line's start
const MAX_STACK = 3; // due stacks start names, the rest counted

// The mode in `.agentry/config.json` (null: none set) and, when the reader refuses a config file, its error:
// `lane exec` refuses the same file, so start says so rather than reading it as no mode.
function modeOf(root) {
  const config = readConfig(root);
  return { mode: config.mode ?? null, ...(config.error && { configError: config.error }) };
}

// A repo's own and the user's facts (what a brief may carry), ranked against `task`; none when memory.prime is off.
function recallFor(root, task) {
  return conductorFacts(root, task).map((f) => ({
    id: f.id,
    type: f.type,
    text: f.body.split("\n")[0],
  }));
}

const summary = (l) => ({ id: l.id, state: l.state, next: l.next && nextStep(l.next) });
// Start's summary also says what a stacked lane is on and what is due on it (`stack.mjs`): `on` (null for a
// lane that is not stacked) and `restack` ("parent", "main", "orphan" or null).
const stackSummary = (root, all) => (l) => ({
  ...summary(l),
  on: l.on ?? null,
  restack: stackOf(root, l, all).due,
});
// The words a due stack's line says about the parent.
const DUE_WORDS = { parent: "moved", main: "landed" };
// A ledger whose episode was not written: one with a payload waiting, and any finished lane (merged, closed,
// stopped) that never wrote one (merged without an exec close, stopped).
const pendingEpisodes = (all) =>
  all.filter(
    (l) =>
      !l.episode?.writtenId && (l.episode || ["merged", "closed", "stopped"].includes(l.state)),
  );

// A held lane as start shows it: what it waits for, where in its steps, since when, the evidence (from
// the root) and the step that answers it: the resume, or for a guard hold its reason and the
// report to run again once main is fixed. A context hold carries its reason, and its resume asks for the
// fact. The owner's holds come before the parked lanes.
const heldOf = (runRoot, all) =>
  all
    .filter((l) => l.state === "held" && l.hold)
    .toSorted((a, b) => (a.hold.for === "later") - (b.hold.for === "later"))
    .map((l) => ({
      id: l.id,
      for: l.hold.for,
      when: l.hold.when,
      steps: l.hold.stepRun && l.steps?.length ? runText(l.hold.stepRun, l.steps.length) : null,
      since: l.hold.since,
      evidence: l.hold.evidence ? relative(runRoot, l.hold.evidence) : null,
      ...(l.hold.why && { why: l.hold.why }),
      ...(l.hold.for === "context" && { reason: l.hold.reason }),
      ...(l.hold.for === "guard"
        ? {
            reason: l.hold.reason,
            report: nextStep(`lane exec report ${l.id} --root ${shellQuote(runRoot)}`),
          }
        : {
            resume: nextStep(
              `lane exec resume ${l.id} --note "${l.hold.for === "context" ? "<the fact>" : "<the OK>"}"`,
            ),
          }),
    }));

// The merged lanes whose merge record is from today, local time; one with no time is not.
const mergedToday = (all) => {
  const today = new Date().toDateString();
  return all.filter((l) => l.state === "merged" && new Date(l.merge?.at).toDateString() === today)
    .length;
};

// The building lanes nothing changed in for `exec.idleMinutes`, read live from the workflow file.
const idleOfAll = (all, spec) =>
  all.flatMap((l) => {
    const idle = idleOf(l.worktree, l, Date.now(), idleMinutes(spec));
    return idle
      ? [{ id: l.id, ...idle, park: nextStep(`lane exec hold ${l.id} --for later`) }]
      : [];
  });

// The `checks` field of start and close: each phase's View, or nothing when neither names a check.
function checksField(runRoot, { root, spec }) {
  const checks = sessionChecksFile.checksView(spec, sessionChecksFile.read(runRoot), root);
  return checks ? { checks } : {};
}

// `asked` is the idle-asked record as read before this start (`readIdleAsked`).
function start({ root, spec, model }, asked) {
  const runRoot = mainRoot(root) ?? root;
  // Counted before anything reads the ledgers or the gate slots: those reads sweep what they find.
  const stale = staleOf(runRoot);
  const work = workKind(spec);
  const status = statusView({ root, spec, model, runRoot });
  if (status.note) markNoteSeen(runRoot, status.note);
  const active = (model.kinds[work]?.items ?? []).filter((i) => i.phase === "active");
  const task = [...status.now.map((s) => s.name), ...active.map((i) => titleOf(spec, i))].join(" ");
  const all = ledgers.list(runRoot);
  const open = all.filter((l) => l.state !== "closed");
  return {
    prompt: spec.conductor?.prompt ? join(root, spec.conductor.prompt) : null,
    ...modeOf(root),
    held: heldOf(runRoot, all),
    idle: sessionChecksFile.withAsked(asked, idleOfAll(all, spec)),
    status,
    recall: recallFor(root, task),
    questions: status.onYou.filter((i) => i.kind !== work),
    ledgers: [
      ...open.filter((l) => l.state === "held"),
      ...open.filter((l) => l.state !== "held"),
    ].map(stackSummary(runRoot, all)),
    mergedToday: mergedToday(all),
    gateSlots: heldSlots(gateLockDir(runRoot)),
    stale,
    vendoredCLI: vendoredCLI(runRoot),
    ...checksField(runRoot, { root, spec }),
  };
}

// What killed holders and writers left, by count: `{ slots, temps }` (`lane sweep --apply` clears them).
function staleOf(runRoot) {
  const { slots, temps } = leftovers(runRoot);
  return { slots: slots.length, temps: temps.length };
}

// The vendored CLI underneath the MAIN checkout's .agentry (`process/lanes.mjs`' vendored(), the reader
// `board explain` shows), null when its stamp is absent or current. runRoot, not root: a lane worktree
// must not imagine a phantom stamp its own .agentry does not carry. The row's value's parts parse back
// out, so the JSON names what the row says — one reader, one text (a second version reader, help.mjs'
// pluginVersion, says more than the row's own does: a build suffix the row does not carry).
function vendoredCLI(runRoot) {
  const row = vendored(runRoot);
  if (!row) return null;
  const [, stamp, current, word] = /^(.*) \(plugin: (.+), ([a-z]+)\)$/.exec(row.value);
  return { stamp, current, word, set: row.set };
}

function closing({ root, spec, model }) {
  const runRoot = mainRoot(root) ?? root;
  const all = ledgers.list(runRoot);
  const { cleanable, unknown, strays, leftAlone, diskFree, warnings } = plan(runRoot);
  const dry = fix(["--json"], { root, spec, model });
  const note = noteView({ root, spec, model, runRoot });
  return {
    drafts: drafts.pending(runRoot),
    fixPlan: JSON.parse(dry.out),
    ledgers: all.map(summary),
    cleanable,
    strays,
    leftAlone,
    unknown,
    warnings,
    diskFree,
    episodesPending: pendingEpisodes(all).map((l) => l.id),
    ...callsField(runRoot),
    ...(note && { note }),
    ...checksField(runRoot, { root, spec }),
  };
}

// The owner's calls not written down, per lane or spike: `calls` whole, and `callLines`, the
// lines to show (one per id, capped), then one naming each ledger file or `spikes.json` it cannot read.
function callsField(runRoot) {
  const { calls, errors } = openCalls(runRoot);
  const lines = callLines(calls).map((l) => nextStep(l));
  return { calls, callLines: [...lines, ...errors.map((e) => `calls: ${e}`)] };
}

// A note on one line (each line break a space), cut to NOTE_COLUMNS with the rest of its line.
const oneLine = (text) => text.replace(/\s*[\r\n]+\s*/g, " ").trim();
const minute = (at) => (Number.isNaN(new Date(at).getTime()) ? at : `${at.slice(0, 16)}Z`);

// An age as `40m`, `5h` or `3d` (whole units, rounded down), from `iso` to now.
const ageText = (iso) => {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
};
// When the owner was asked: `HH:MM` today, `YYYY-MM-DD HH:MM` (local) on another day.
const askedAt = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.toDateString() === new Date().toDateString())
    return clock(iso);
  const day = [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n) =>
    String(n).padStart(2, "0"),
  );
  return `${day.join("-")} ${clock(iso)}`;
};
const idsText = (ids) => (ids.length ? ids.join(", ") : "none");
// The one stale line of a note: the Now it was written under is gone, else every id it names is done.
const staleText = ({ stale, writtenAt, path }) =>
  stale.why === "now-changed"
    ? `note: stale, written ${ageText(writtenAt)} ago when the Now was ${idsText(stale.was)}, now ${idsText(stale.now)} → rewrite or clear ${path}`
    : `note: stale, every id it names is done → edit ${path} (${stale.ids.join(", ")})`;

// The check lines of start: what to run now, a named skill the repo lacks, and how the last close went.
function startChecks({ start: now, close: last }, { add, addList }) {
  if (now.pending.length) {
    addList("start checks: ", now.pending, " (run each, then record it)");
    add(`  → ${nextStep('lane session start --check <skill>=pass|fail --note "<line>"')}`);
  }
  for (const m of now.missing.slice(0, MAX_MISSING)) {
    add(`start checks: ${m} has no ${SKILL_DIR}/${m}/SKILL.md`);
    add("  → /agentry:init");
  }
  if (now.missing.length > MAX_MISSING)
    add(`start checks: +${now.missing.length - MAX_MISSING} more have no SKILL.md → /agentry:init`);
  if (!last.recorded.length) return;
  const passed = last.recorded.filter((r) => r.result === "pass").length;
  add(`last close: ${passed}/${last.named.length} passed (${minute(last.recorded.at(-1).at)})`);
  const failed = last.recorded.filter((r) => r.result === "fail");
  for (const f of failed.slice(0, MAX_FAILED))
    add(`last close: ${f.skill} failed${f.note ? ` · ${oneLine(f.note)}` : ""}`, NOTE_COLUMNS);
  if (failed.length > MAX_FAILED) add(`last close: +${failed.length - MAX_FAILED} more failed`);
}

function renderStart(s, { name, root }) {
  const mode = s.configError ? "unreadable" : (s.mode ?? "none set");
  const lines = [fit(`${name} · session start · mode ${mode}`, WIDTH)];
  const add = (text, width = WIDTH) => lines.push(fit(text, width));
  if (s.configError) add(`config: ${s.configError.replace(`${root}/`, "")}`);
  // A list wraps onto up to MAX_LIST lines; what does not fit is counted, never silently cut. `tail` ends
  // its last line, after the count too.
  const addList = (label, items, tail = "") => {
    let line = label;
    let sep = "";
    let used = 1;
    for (const [i, item] of items.entries()) {
      // Keep room for what follows the item unless it is the final one: the ", +N more" tail on the last
      // line, else the comma a wrapped line ends with.
      const room =
        WIDTH - (i === items.length - 1 ? tail.length : used === MAX_LIST ? 12 + tail.length : 1);
      if ([...(line + sep + item)].length > room && line.trim() !== label.trim() && line.trim()) {
        if (used === MAX_LIST) return add(`${line}, +${items.length - i} more${tail}`);
        add(`${line},`);
        used++;
        line = "  ";
        sep = "";
      }
      line += sep + item;
      sep = ", ";
    }
    add(line + tail);
  };
  add(
    s.prompt
      ? `conductor prompt: ${relative(root, s.prompt)} (read it once)`
      : "conductor prompt: none set",
  );
  // The vendored CLI's stamp behind the plugin, as `board explain` says it: one `!` advisory line after
  // the prompt, silent when the stamp is current or absent; a whole line, so the set step is never cut.
  if (s.vendoredCLI)
    add(
      `! vendored CLI: ${s.vendoredCLI.stamp} (plugin: ${s.vendoredCLI.current}, ${s.vendoredCLI.word}) → ${nextStep(s.vendoredCLI.set)}`,
      Number.POSITIVE_INFINITY,
    );
  if (s.checks) startChecks(s.checks, { add, addList });
  // The lanes that wait on the owner, before anything else the session holds.
  // A parked lane reads like a held one: its why, its evidence when it has one, and the resume.
  for (const h of s.held.slice(0, MAX_HELD)) {
    if (h.for === "guard") {
      add(`held: ${h.id} guard tripped, since ${clock(h.since)}`);
      add(`  reason: ${h.reason}`);
      add(`  → ${h.report} (after fixing it)`, Number.POSITIVE_INFINITY); // a step to run: never cut
      continue;
    }
    // A context hold reads as `exec show` prints it (exec-view's heldText), its reason never cut.
    if (h.for === "context") add(`held: ${h.id} ${heldText(h, 0)}`, Number.POSITIVE_INFINITY);
    else if (h.for === "later")
      add(`parked: ${h.id} since ${clock(h.since)}${h.why ? `: "${oneLine(h.why)}"` : ""}`);
    else
      add(
        `held: ${h.id} for the owner, ${h.steps ? `${h.when} ${h.steps}` : "mid-build"}, since ${clock(h.since)}`,
      );
    if (h.evidence) add(`  evidence: ${h.evidence}`);
    add(`  → ${h.resume}`);
  }
  if (s.held.length > MAX_HELD)
    add(`held: +${s.held.length - MAX_HELD} more → ${nextStep("lane session start --json")}`);
  // Lanes newly idle at their lastChange: one question for all of them first (they are recorded as asked
  // only when it is within the 40 lines), then a block each, capped as held is, the park step on its own
  // line so 80 columns never cut it. The lanes already asked: one quiet line.
  const fresh = s.idle.filter((i) => !i.asked);
  const park = nextStep("lane exec hold <id> --for later");
  if (fresh.length)
    add(
      `${QUESTION}${fresh.map((i) => i.id).join(", ")}? yes → ${park} (each)`,
      Number.POSITIVE_INFINITY,
    );
  for (const i of fresh.slice(0, MAX_IDLE)) {
    add(`idle: ${idleHead(i.id, i)}`);
    add(`  → ${i.park} to park it`);
  }
  if (fresh.length > MAX_IDLE)
    add(`idle: +${fresh.length - MAX_IDLE} more → ${nextStep("lane session start --json")}`);
  const asked = s.idle.filter((i) => i.asked);
  if (asked.length) {
    // The newest ask by its time; a value that is no time never wins (and reads `?` only when alone).
    const times = asked.map((i) => i.asked).filter((a) => Number.isFinite(Date.parse(a)));
    const last = times.toSorted((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? asked[0].asked;
    add(
      `idle: ${asked.map((i) => i.id).join(", ")} (asked ${askedAt(last)}; park: ${park})`,
      Number.POSITIVE_INFINITY,
    );
  }
  // The count comes before the name, so a long name is what the line loses.
  for (const n of s.status.now)
    add(`now: ${n.id} ${n.done}/${n.total}${n.name ? ` · ${n.name}` : ""}`);
  if (!s.status.now.length) add("now: no active sprint");
  // The note's first lines (headings and blanks skipped), the later ones indented under the label; a note
  // 12 h old or more says its age (from the file's mtime) in the label.
  const { note } = s.status;
  const label = note?.old ? `note (${ageText(note.writtenAt)} old): ` : "note: ";
  (note?.lines ?? [])
    .filter((l) => l.trim() && !l.startsWith("#"))
    .slice(0, NOTE_LINES)
    .forEach((l, i) => add(i ? `      ${l.trim()}` : `${label}${l.trim()}`));
  // The step ends the line: the path is never cut.
  if (note?.stale) add(staleText(note), Number.POSITIVE_INFINITY);
  if (s.status.inFlight.length)
    addList(
      "in flight: ",
      s.status.inFlight.map((i) => `${i.id} (${i.status})`),
    );
  if (s.status.onYou.length)
    addList(
      "on you: ",
      s.status.onYou.map((i) => `${i.id} (${i.status})`),
    );
  for (const n of s.status.nudges.slice(0, 5))
    add(`drift: ${n.kind} ${n.id ?? n.branch ?? basename(n.path ?? "")} → ${n.command}`);
  if (s.status.nudges.length > 5)
    add(`drift: +${s.status.nudges.length - 5} more (/agentry:board)`);
  if (s.status.drafts) add(`drafts: ${s.status.drafts} pending → /agentry:close`);
  // The open lanes (the held ones are above), then how many merged today.
  const lanes = s.ledgers.filter((l) => !["held", "merged", "closed"].includes(l.state));
  if (lanes.length || s.mergedToday)
    addList(
      "lanes: ",
      lanes.length
        ? lanes.map((l) => `${l.id} ${l.state}${l.on ? ` on ${l.on}` : ""}`)
        : ["none open"],
      ` · ${s.mergedToday} merged today`,
    );
  // Each stacked lane with something due, after the lanes it is one of.
  const due = s.ledgers.filter((l) => l.restack);
  for (const l of due.slice(0, MAX_STACK)) {
    // A closed parent is not among the open ledgers start lists.
    const state = s.ledgers.find((p) => p.id === l.on)?.state ?? "closed or gone";
    const what = DUE_WORDS[l.restack] ?? `is ${state}`;
    // An orphan comes off its parent only with --main: the line names the step that runs.
    const step = `lane exec restack ${l.id}${l.restack === "orphan" ? " --main" : ""}`;
    add(`stack: ${l.id} on ${l.on}: ${l.on} ${what} → ${nextStep(step)}`);
  }
  if (due.length > MAX_STACK)
    add(`stack: +${due.length - MAX_STACK} more → ${nextStep("lane session start --json")}`);
  if (s.gateSlots.length)
    addList(
      "gate: ",
      s.gateSlots.map((g) => `slot ${g.slot} held by ${g.who || "unknown"} since ${g.since}`),
    );
  if (s.stale.slots || s.stale.temps)
    add(
      `! stale: ${s.stale.slots} lock slot(s), ${s.stale.temps} temp file(s) → ${nextStep("lane sweep --apply")}`,
    );
  for (const f of s.recall.slice(0, 3)) add(`recall: ${f.text}`);
  return lines.slice(0, MAX_LINES).join("\n");
}

// argv → { words, json, check, note } or { error }; the router has already refused any other option.
function parse(argv) {
  const out = { words: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--check" || arg === "--note") {
      const key = arg.slice(2);
      if (Object.hasOwn(out, key)) return { error: `${arg} is given twice` };
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) return { error: `${arg} needs a value` };
      out[key] = value;
    } else out.words.push(arg);
  }
  return out;
}

// `<k>/<n> recorded · pending: a, b · failed: c`, an empty part left out.
const countsLine = (phase, v) =>
  [
    `${phase} checks: ${v.recorded.length}/${v.named.length} recorded`,
    v.pending.length && `pending: ${v.pending.join(", ")}`,
    v.failed.length && `failed: ${v.failed.join(", ")}`,
  ]
    .filter(Boolean)
    .join(" · ");

// Record `--check <skill>=pass|fail` for `phase`: validated like `lane merge --check`, then one entry.
function check(phase, { check: value, note, json }, { root, spec }) {
  const what = `lane session ${phase} --check`;
  const given = /^([^=]+)=(pass|fail)$/.exec(value);
  if (!given) return usageError("lane session", `--check takes <skill>=pass|fail, not "${value}"`);
  const [, skill, result] = given;
  const names = sessionChecks(spec, phase);
  if (!names.includes(skill))
    return refuse(
      what,
      `"${skill}" is not in extensions.${phase}.checks (${names.length ? names.join(", ") : "none named"})`,
    );
  if (!skillExists(root, skill))
    return refuse(
      what,
      `extensions.${phase}.checks names "${skill}", but ${SKILL_DIR}/${skill}/SKILL.md is missing`,
    );
  const runRoot = mainRoot(root) ?? root;
  const entry = {
    phase,
    skill,
    result,
    ...(note?.trim() && { note }),
    at: new Date().toISOString(),
  };
  sessionChecksFile.record(runRoot, entry);
  const view = sessionChecksFile.checksView(spec, sessionChecksFile.read(runRoot), root)[phase];
  if (json) {
    const { phase: _, ...rest } = entry;
    const { recorded, named, pending, failed } = view;
    return {
      exit: 0,
      out: JSON.stringify({
        phase,
        ...rest,
        recorded: recorded.length,
        total: named.length,
        pending,
        failed,
      }),
    };
  }
  const mark = result === "pass" ? "✓" : "✗";
  const said = `${mark} ${phase} check ${skill}: ${result}${entry.note ? ` · ${oneLine(entry.note)}` : ""}`;
  return { exit: 0, out: `${said}\n${countsLine(phase, view)}` };
}

export function run(argv, ctx) {
  try {
    return runSession(argv, ctx);
  } catch (err) {
    if (err.unusable) return refuse("lane session", err.message);
    throw err;
  }
}

function runSession(argv, ctx) {
  const opts = parse(argv);
  if (opts.error) return usageError("lane session", opts.error);
  const [sub, ...rest] = opts.words;
  if (!["start", "close"].includes(sub) || rest.length)
    return usageError("lane session", "needs start or close");
  if (opts.note !== undefined && opts.check === undefined)
    return usageError("lane session", "--note goes with --check");
  if (opts.check !== undefined) return check(sub, opts, ctx);
  if (sub === "close") return { exit: 0, out: JSON.stringify(closing(ctx)) };
  const runRoot = mainRoot(ctx.root) ?? ctx.root;
  const before = sessionChecksFile.readIdleAsked(runRoot);
  const data = start(ctx, before);
  const text = renderStart(data, { name: ctx.spec.name, root: ctx.root });
  // The text decides what is recorded, with --json too: a newly idle lane counts as asked only when the
  // question line is within the 40 lines.
  const asking = text.split("\n").some((l) => l.startsWith(QUESTION));
  sessionChecksFile.recordIdleAsked(runRoot, before, data.idle, { asking });
  return { exit: 0, out: opts.json ? JSON.stringify(data) : text };
}
