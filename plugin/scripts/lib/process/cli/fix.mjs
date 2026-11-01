// board fix [--dry-run] [--json] — write what is mechanical, report the rest (A31; plan R1b-6). A task whose
// ledger's work is on main now (`drift.mechanical`) and whose board row lacks the done status, the commit
// cell or the handoff line gets the lifecycle's `merged` event narrowed to those missing steps, through
// `applyEvent`, in one write: a step the board already has (a hand-written cell, any handoff line for the
// task) is never written again. Every other drift is listed with the command that deals with it. The output
// lists exactly the writes made; running it again finds nothing to do; `--dry-run` writes nothing.
//
// run(argv, { root, spec, model }) -> { exit, out }   exit 0 = nothing left for the owner, 1 = items left
// to report, 2 = usage
import { basename } from "node:path";
import { mainRoot } from "../../lane/worktree.mjs";
import { mechanical, nudges } from "../drift.mjs";
import { applyEvent } from "../lifecycle.mjs";
import { readProcess } from "../read.mjs";
import { fit } from "../render.mjs";
import { titleOf } from "../status.mjs";
import { WriteError } from "../write.mjs";

export const usage = "fix [--dry-run] [--json]";
export const flags = { "--dry-run": false, "--json": false };
const WIDTH = 80;
const FIX = "/agentry:board --fix";

// The process file with the lifecycle writing only `need`: the steps it drops are skipped by `applyEvent`.
const narrowed = (spec, need) => ({
  ...spec,
  lifecycle: {
    ...spec.lifecycle,
    write: Object.fromEntries(need.map((step) => [step, spec.lifecycle.write[step]])),
  },
});

export function run(argv, { root, spec, model }) {
  const dryRun = argv.includes("--dry-run");
  const runRoot = mainRoot(root) ?? root;
  const plan = mechanical({ root, runRoot, spec, model });
  const fixed = [];
  const left = [...plan.left];
  let board = model;
  for (const f of plan.fixes) {
    const item = (Object.hasOwn(board.index, f.id) ? board.index[f.id] : []).find(
      (i) => i.kind === spec.lifecycle.kind,
    );
    const entry = { id: f.id, need: f.need, sha: f.shas[0].slice(0, 7) };
    if (dryRun) {
      fixed.push(entry);
      continue;
    }
    try {
      const summary = (item && titleOf(spec, item)) || f.id;
      const { writes } = applyEvent({
        root,
        spec: narrowed(spec, f.need),
        model: board,
        event: "merged",
        id: f.id,
        data: { shas: f.shas, summary },
      });
      if (writes.length) fixed.push({ ...entry, writes: writes.map((w) => w.what) });
      board = readProcess({ root, spec }); // the next task is edited against what is on disk now
    } catch (e) {
      if (!(e instanceof WriteError)) throw e;
      left.push(`${f.id}: not fixed (${e.message})`);
    }
  }
  const after = dryRun ? model : board;
  // A nudge to run fix is this run's own business: its task is fixed (or would be) or in `left`.
  const rest = nudges({ root, runRoot, spec, model: after }).filter((n) => n.command !== FIX);
  const exit = left.length || rest.length ? 1 : 0;
  if (argv.includes("--json"))
    return { exit, out: JSON.stringify({ dryRun, fixed, left, nudges: rest }) };
  return { exit, out: render({ dryRun, fixed, left, rest }) };
}

function render({ dryRun, fixed, left, rest }) {
  const verb = dryRun ? "would fix" : "fixed";
  const head = `${verb} ${fixed.length}, ${left.length + rest.length} left for you${dryRun ? " (dry run: nothing written)" : ""}`;
  const lines = [head];
  for (const f of fixed) {
    const what = f.writes ? f.writes.join(", ") : `${f.need.join(", ")} from commit ${f.sha}`;
    lines.push(fit(`  ${f.id}  ${what}`, WIDTH));
  }
  if (left.length + rest.length) lines.push("left for you:");
  for (const text of left) lines.push(fit(`  ${text}`, WIDTH));
  for (const n of rest) {
    const subject = n.id ?? basename(n.path ?? n.branch ?? "");
    lines.push(fit(`  ${n.kind} ${subject} → ${n.command}`, WIDTH));
  }
  return lines.join("\n");
}
