// lane session <start|close> [--json] — the opening and the ending of a session (plan R1b-7, F20, A36).
//
//   start   what the conductor needs once, in one object: the conductor prompt's path, the mode, the derived
//           status (nudges and pending drafts included), recall ranked against the work in flight, the owner's
//           open questions and the lane ledgers. Printed as at most 40 lines, or `--json`.
//   close   what the ending walks through: the pending drafts, what `board fix` would write, the ledgers, what
//           `lane sweep --apply` would clean, the disk, and the episodes nobody wrote. Always JSON.
//
// It only reads: board fix, the drafts and the sweep each do their own writing, when the command says so. The
// mode is read from `.agentry/config.json` as written and never interpreted here (A29).
// Exit 0, or 2 for a usage error.
//
// run(argv, { root, spec, model }) -> { exit, out }
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { rankFacts, readFacts, readMemoryConfig } from "../../memory/recall.mjs";
import { run as fix } from "../../process/cli/fix.mjs";
import * as drafts from "../../process/drafts.mjs";
import * as ledgers from "../../process/ledger.mjs";
import { fit } from "../../process/render.mjs";
import { statusView, titleOf, workKind } from "../../process/status.mjs";
import { plan } from "../sweep.mjs";
import { mainRoot } from "../worktree.mjs";

export const usage = "session <start|close> [--json]";
export const flags = { "--json": false };
const WIDTH = 80;
const MAX_LINES = 40;

// The mode in `.agentry/config.json`, or null: no file, no mode, or a file this can't read.
function modeOf(root) {
  try {
    const file = join(root, ".agentry", "config.json");
    const mode = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).mode : null;
    return typeof mode === "string" ? mode : null;
  } catch {
    return null;
  }
}

// A repo's own and the user's facts (what a brief may carry), ranked against `task`; none when memory.prime is off.
function recallFor(root, task) {
  const config = readMemoryConfig(root);
  if (config.prime === "off") return [];
  const mine = readFacts(root).filter(
    (f) => f.source === "project" || f.scope === "user" || f.scope === "global",
  );
  return rankFacts(mine, task, config.primeLimit).map((f) => ({
    id: f.id,
    type: f.type,
    text: f.body.split("\n")[0],
  }));
}

const summary = (l) => ({ id: l.id, state: l.state, next: l.next });
const pendingEpisodes = (all) => all.filter((l) => l.episode && !l.episode.writtenId);

function start({ root, spec, model }) {
  const runRoot = mainRoot(root) ?? root;
  const work = workKind(spec);
  const status = statusView({ root, spec, model, runRoot });
  const active = (model.kinds[work]?.items ?? []).filter((i) => i.phase === "active");
  const task = [...status.now.map((s) => s.name), ...active.map((i) => titleOf(spec, i))].join(" ");
  const all = ledgers.list(runRoot);
  return {
    prompt: spec.conductor?.prompt ? join(root, spec.conductor.prompt) : null,
    mode: modeOf(root),
    status,
    recall: recallFor(root, task),
    questions: status.onYou.filter((i) => i.kind !== work),
    ledgers: all.filter((l) => l.state !== "closed").map(summary),
  };
}

function closing({ root, spec, model }) {
  const runRoot = mainRoot(root) ?? root;
  const all = ledgers.list(runRoot);
  const { cleanable, unknown, strays, diskFree, warnings } = plan(runRoot);
  const dry = fix(["--dry-run", "--json"], { root, spec, model });
  return {
    drafts: drafts.pending(runRoot),
    fixPlan: JSON.parse(dry.out),
    ledgers: all.map(summary),
    cleanable,
    strays,
    unknown,
    warnings,
    diskFree,
    episodesPending: pendingEpisodes(all).map((l) => l.id),
  };
}

function renderStart(s, { name, root }) {
  const lines = [fit(`${name} · session start · mode ${s.mode ?? "none set"}`, WIDTH)];
  const add = (text) => lines.push(fit(text, WIDTH));
  add(
    s.prompt
      ? `conductor prompt: ${relative(root, s.prompt)} (read it once)`
      : "conductor prompt: none set",
  );
  for (const n of s.status.now)
    add(`now: ${[n.id, n.name].filter(Boolean).join(" ")} — ${n.done}/${n.total} done`);
  if (!s.status.now.length) add("now: no active sprint");
  if (s.status.inFlight.length)
    add(`in flight: ${s.status.inFlight.map((i) => `${i.id} (${i.status})`).join(", ")}`);
  if (s.status.onYou.length)
    add(`on you: ${s.status.onYou.map((i) => `${i.id} (${i.status})`).join(", ")}`);
  if (s.questions.length) add(`open questions: ${s.questions.map((q) => q.id).join(", ")}`);
  for (const n of s.status.nudges.slice(0, 5))
    add(`drift: ${n.kind} ${n.id ?? n.branch ?? ""} → ${n.command}`);
  if (s.status.nudges.length > 5)
    add(`drift: +${s.status.nudges.length - 5} more (/agentry:board)`);
  if (s.status.drafts) add(`drafts: ${s.status.drafts} pending → /agentry:close`);
  if (s.ledgers.length) add(`lanes: ${s.ledgers.map((l) => `${l.id} ${l.state}`).join(", ")}`);
  for (const f of s.recall.slice(0, 3)) add(`recall: ${f.text}`);
  return lines.slice(0, MAX_LINES).join("\n");
}

export function run(argv, ctx) {
  const [sub, ...rest] = argv.filter((a) => a !== "--json");
  if (!["start", "close"].includes(sub) || rest.length) return { exit: 2, out: `usage: ${usage}` };
  const data = sub === "start" ? start(ctx) : closing(ctx);
  if (argv.includes("--json") || sub === "close") return { exit: 0, out: JSON.stringify(data) };
  return { exit: 0, out: renderStart(data, { name: ctx.spec.name, root: ctx.root }) };
}
