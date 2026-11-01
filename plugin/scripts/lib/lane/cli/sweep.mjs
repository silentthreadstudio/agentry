// lane sweep [--apply [--discard-ignored]] [--json] — clean up after a session (plan R1b-7, #8, #9). Without
// `--apply` it only reports: the worktrees of merged or closed tasks, the worktrees no ledger knows (never
// removed), the processes left running under `.agentry/run/` by a finished lane or by none (an interactive
// shell among them is listed as left alone, never stopped), and a low-disk or no-lsof warning. With
// `--apply` it stops those processes (each with its descendants) and removes the worktrees, and nothing
// else; a worktree holding ignored files (`.env`, build output) stays unless `--discard-ignored`.
// Needs no process file.
// Exit 0 = done or reported, 1 = `--apply` left a worktree it could not remove or a process running.
//
// run(argv, { root }) -> { exit, out }
import { apply, ignoredReason, plan } from "../sweep.mjs";
import { mainRoot } from "../worktree.mjs";

export const usage = "sweep [--apply [--discard-ignored]] [--json]";
export const flags = { "--apply": false, "--discard-ignored": false, "--json": false };
export const noSpec = true;

export function run(argv, { root }) {
  const runRoot = mainRoot(root) ?? root;
  const found = plan(runRoot);
  const discardIgnored = argv.includes("--discard-ignored");
  const done = argv.includes("--apply") ? apply(runRoot, found, { discardIgnored }) : null;
  const exit = done?.kept.length || done?.survived.length ? 1 : 0;
  if (argv.includes("--json")) return { exit, out: JSON.stringify({ ...found, applied: done }) };
  return { exit, out: render(found, done, discardIgnored) };
}

function render(found, done, discardIgnored) {
  const lines = [done ? "sweep (applied)" : "sweep (dry run: nothing changed; --apply to act)"];
  // Paths and command lines are shown whole: cutting one would hide what is about to be stopped.
  const row = (text) => lines.push(`  ${text}`);
  for (const w of found.cleanable) {
    const kept = done?.kept.find((k) => k.id === w.id);
    const holds = w.ignored?.length > 0 && !discardIgnored;
    const verb = !done ? (holds ? "would keep" : "would remove") : kept ? "kept" : "removed";
    const why = kept ? kept.reason : !done && holds ? ignoredReason(w) : "";
    row(`${verb} worktree ${w.id}${why ? `: ${why}` : ""}`);
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
  }
  for (const p of found.leftAlone) row(`left alone: ${p.reason} ${p.pid}  ${p.command}`);
  if (done?.survivors.length) row(`still running after SIGKILL: ${done.survivors.join(", ")}`);
  for (const w of found.warnings) row(`warning: ${w}`);
  if (lines.length === 1) row("nothing to clean");
  return lines.join("\n");
}
