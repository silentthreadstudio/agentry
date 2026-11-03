// lane session <start|close> [--json] — the opening and the ending of a session (plan R1b-7, F20, A36).
//
//   start   what the conductor needs once, in one object: the conductor prompt's path, the mode, the derived
//           status (nudges and pending drafts included), recall ranked against the work in flight, the owner's
//           open questions and the lane ledgers. Printed as at most 40 lines, or `--json`.
//   close   what the ending walks through: the pending drafts, what `board fix` would write, the ledgers, what
//           `lane sweep --apply` would clean, the disk, and the episodes nobody wrote. Always JSON.
//
// It only reads: board fix, the drafts and the sweep each do their own writing, when the command says so. The
// mode comes from the config reader (`mode` in `.agentry/config.json`) and is never interpreted here (A29).
// Exit 0, or 2 for a usage error.
//
// run(argv, { root, spec, model }) -> { exit, out }
import { basename, join, relative } from "node:path";
import { usageError } from "../../cli/help.mjs";
import { nextStep } from "../../cli/invoke.mjs";
import { readConfig } from "../../config.mjs";
import { rankFacts, readFacts, readMemoryConfig } from "../../memory/recall.mjs";
import { run as fix } from "../../process/cli/fix.mjs";
import * as drafts from "../../process/drafts.mjs";
import * as ledgers from "../../process/ledger.mjs";
import { fit } from "../../process/render.mjs";
import { statusView, titleOf, workKind } from "../../process/status.mjs";
import { forThisRepo, primeLimitOf } from "../brief.mjs";
import { plan } from "../sweep.mjs";
import { mainRoot } from "../worktree.mjs";

export const help = {
  usage: "session <start|close> [--json]",
  purpose: "What opening or ending a session needs, in one read. Writes nothing.",
  args: {
    start: "prompt, mode, status, recall, open questions, lanes (40 lines, or --json)",
    close: "drafts, the board fix plan, ledgers, the sweep plan, pending episodes (always JSON)",
  },
  flags: { "--json": "print start as one JSON object (close always is)" },
  exits: { 0: "printed", 2: "usage, or a process file it cannot use" },
  example: "lane session start",
};
const WIDTH = 80;
const MAX_LINES = 40;
const MAX_LIST = 4; // lines one list may take
const NOTE_LINES = 3; // lines of the note that start prints

// The mode in `.agentry/config.json` (null: none set) and, when the reader refuses a config file, its error:
// `lane exec` refuses the same file, so start says so rather than reading it as no mode.
function modeOf(root) {
  const config = readConfig(root);
  return { mode: config.mode ?? null, ...(config.error && { configError: config.error }) };
}

// A repo's own and the user's facts (what a brief may carry), ranked against `task`; none when memory.prime is off.
function recallFor(root, task) {
  const config = readMemoryConfig(root);
  if (config.prime === "off") return [];
  return rankFacts(readFacts(root).filter(forThisRepo), task, primeLimitOf(config)).map((f) => ({
    id: f.id,
    type: f.type,
    text: f.body.split("\n")[0],
  }));
}

const summary = (l) => ({ id: l.id, state: l.state, next: l.next && nextStep(l.next) });
// A ledger whose episode was not written: one with a payload waiting, and any finished lane (merged, closed,
// stopped) that never wrote one (merged without an exec close, stopped).
const pendingEpisodes = (all) =>
  all.filter(
    (l) =>
      !l.episode?.writtenId && (l.episode || ["merged", "closed", "stopped"].includes(l.state)),
  );

function start({ root, spec, model }) {
  const runRoot = mainRoot(root) ?? root;
  const work = workKind(spec);
  const status = statusView({ root, spec, model, runRoot });
  const active = (model.kinds[work]?.items ?? []).filter((i) => i.phase === "active");
  const task = [...status.now.map((s) => s.name), ...active.map((i) => titleOf(spec, i))].join(" ");
  const all = ledgers.list(runRoot);
  return {
    prompt: spec.conductor?.prompt ? join(root, spec.conductor.prompt) : null,
    ...modeOf(root),
    status,
    recall: recallFor(root, task),
    questions: status.onYou.filter((i) => i.kind !== work),
    ledgers: all.filter((l) => l.state !== "closed").map(summary),
  };
}

function closing({ root, spec, model }) {
  const runRoot = mainRoot(root) ?? root;
  const all = ledgers.list(runRoot);
  const { cleanable, unknown, strays, leftAlone, diskFree, warnings } = plan(runRoot);
  const dry = fix(["--json"], { root, spec, model });
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
  };
}

function renderStart(s, { name, root }) {
  const mode = s.configError ? "unreadable" : (s.mode ?? "none set");
  const lines = [fit(`${name} · session start · mode ${mode}`, WIDTH)];
  const add = (text) => lines.push(fit(text, WIDTH));
  if (s.configError) add(`config: ${s.configError.replace(`${root}/`, "")}`);
  // A list wraps onto up to MAX_LIST lines; what does not fit is counted, never silently cut.
  const addList = (label, items) => {
    let line = label;
    let sep = "";
    let used = 1;
    for (const [i, item] of items.entries()) {
      // Keep room for what follows the item unless it is the final one: the ", +N more" tail on the last
      // line, else the comma a wrapped line ends with.
      const room = WIDTH - (i === items.length - 1 ? 0 : used === MAX_LIST ? 12 : 1);
      if ([...(line + sep + item)].length > room && line.trim() !== label.trim() && line.trim()) {
        if (used === MAX_LIST) return add(`${line}, +${items.length - i} more`);
        add(`${line},`);
        used++;
        line = "  ";
        sep = "";
      }
      line += sep + item;
      sep = ", ";
    }
    add(line);
  };
  add(
    s.prompt
      ? `conductor prompt: ${relative(root, s.prompt)} (read it once)`
      : "conductor prompt: none set",
  );
  // The count comes before the name, so a long name is what the line loses.
  for (const n of s.status.now)
    add(`now: ${n.id} ${n.done}/${n.total}${n.name ? ` · ${n.name}` : ""}`);
  if (!s.status.now.length) add("now: no active sprint");
  // The note's first lines (headings and blanks skipped), the later ones indented under the label.
  const note = (s.status.note?.lines ?? []).filter((l) => l.trim() && !l.startsWith("#"));
  note.slice(0, NOTE_LINES).forEach((l, i) => add(i ? `      ${l.trim()}` : `note: ${l.trim()}`));
  const stale = s.status.note?.stale;
  if (stale)
    add(
      `note: stale, every id it names is done (${stale.join(", ")}) → edit ${s.status.note.path}`,
    );
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
  if (s.ledgers.length)
    addList(
      "lanes: ",
      s.ledgers.map((l) => `${l.id} ${l.state}`),
    );
  for (const f of s.recall.slice(0, 3)) add(`recall: ${f.text}`);
  return lines.slice(0, MAX_LINES).join("\n");
}

export function run(argv, ctx) {
  const [sub, ...rest] = argv.filter((a) => a !== "--json");
  if (!["start", "close"].includes(sub) || rest.length)
    return usageError("lane session", "needs start or close");
  const data = sub === "start" ? start(ctx) : closing(ctx);
  if (argv.includes("--json") || sub === "close") return { exit: 0, out: JSON.stringify(data) };
  return { exit: 0, out: renderStart(data, { name: ctx.spec.name, root: ctx.root }) };
}
