// lane sweep [--apply [--discard-ignored]] [--json] — clean up after a session (plan R1b-7, #8, #9). Without
// `--apply` it only reports: the worktrees of merged or closed tasks, the worktrees no ledger knows (never
// removed), the processes left running under `.agentry/run/` by a finished lane or by none (an interactive
// shell among them is listed as left alone, never stopped), and a low-disk or no-lsof warning. With
// `--apply` it stops those processes (each with its descendants) and removes the worktrees, and nothing
// else; a worktree holding ignored files (`.env`, screenshots) stays unless `--discard-ignored`. Build
// output (`node_modules`, `dist`, and the process file's `cleanup.disposable`) is discarded without asking.
// Needs no process file: without one, only the defaults are disposable.
// Exit 0 = done or reported, 1 = `--apply` left a worktree it could not remove or a process running.
//
// run(argv, { root }) -> { exit, out }
import { loadSpec } from "../../process/read.mjs";
import { apply, keepReason, plan } from "../sweep.mjs";
import { mainRoot } from "../worktree.mjs";

export const help = {
  usage: "sweep [--apply [--discard-ignored]] [--json]",
  purpose: "Clean up after a session: finished lanes' worktrees and the processes left running.",
  args: {},
  flags: {
    "--apply": "stop those processes and remove those worktrees (without it: only report)",
    "--discard-ignored": "with --apply: also remove a worktree that holds ignored files",
    "--json": "print { applied, …the plan, result } (result: what --apply did, else null)",
  },
  exits: { 0: "done or reported", 1: "--apply left a worktree or a process" },
  example: "lane sweep --apply",
};
export const noSpec = true;

export function run(argv, { root, processPath }) {
  const runRoot = mainRoot(root) ?? root;
  const { spec } = loadSpec(processPath, { root });
  const found = plan(runRoot, { disposable: spec?.cleanup?.disposable ?? [] });
  const discardIgnored = argv.includes("--discard-ignored");
  const done = argv.includes("--apply") ? apply(runRoot, found, { discardIgnored }) : null;
  const exit = done?.kept.length || done?.survived.length ? 1 : 0;
  if (argv.includes("--json"))
    return { exit, out: JSON.stringify({ applied: Boolean(done), ...found, result: done }) };
  return { exit, out: render(found, done, discardIgnored) };
}

function render(found, done, discardIgnored) {
  const lines = [done ? "sweep (applied)" : "sweep (preview: nothing changed; add --apply to act)"];
  // Paths and command lines are shown whole: cutting one would hide what is about to be stopped.
  const row = (text) => lines.push(`  ${text}`);
  for (const w of found.cleanable) {
    const kept = done?.kept.find((k) => k.id === w.id);
    const why = kept ? kept.reason : keepReason(w, discardIgnored);
    const verb = !done ? (why ? "would keep" : "would remove") : kept ? "kept" : "removed";
    const thrown = w.disposable?.length ?? 0;
    const discard =
      !why && thrown
        ? ` (${done ? "discarded" : "would discard"} ${thrown} disposable file(s))`
        : "";
    row(`${verb} worktree ${w.id}${why && verb !== "removed" ? `: ${why}` : ""}${discard}`);
  }
  for (const w of found.unknown) row(`unknown worktree ${w.path} (left alone)`);
  for (const p of found.strays) {
    const verb = !done
      ? "would stop"
      : done.killed.includes(p.pid)
        ? "stopped"
        : done.survived.includes(p.pid)
          ? "STILL RUNNING:"
          : "already gone:";
    row(`${verb} process ${p.pid}  ${p.command}`);
    for (const w of p.with) row(`  with process ${w.pid}  ${w.command}`);
  }
  for (const p of found.leftAlone) row(`left alone: ${p.reason} ${p.pid}  ${p.command}`);
  if (done?.signalled.length) row(`signalled: ${done.signalled.join(", ")}`);
  if (done?.survivors.length) row(`still running after SIGKILL: ${done.survivors.join(", ")}`);
  for (const w of found.warnings) row(`warning: ${w}`);
  if (lines.length === 1) row("nothing to clean");
  return lines.join("\n");
}
