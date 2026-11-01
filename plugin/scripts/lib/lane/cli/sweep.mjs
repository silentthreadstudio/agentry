// lane sweep [--apply] [--json] — clean up after a session (plan R1b-7, #8, #9). Without `--apply` it only
// reports: the worktrees of merged tasks, the worktrees no ledger knows (never removed), the processes left
// running under `.agentry/run/`, and a low-disk warning. With `--apply` it removes the merged tasks'
// worktrees and sends SIGTERM to those processes, and nothing else. Needs no process file.
// Exit 0 = done or reported, 1 = `--apply` left a worktree it could not remove.
//
// run(argv, { root }) -> { exit, out }
import { apply, plan } from "../sweep.mjs";
import { mainRoot } from "../worktree.mjs";

export const usage = "sweep [--apply] [--json]";
export const flags = { "--apply": false, "--json": false };
export const noSpec = true;

export function run(argv, { root }) {
  const runRoot = mainRoot(root) ?? root;
  const found = plan(runRoot);
  const done = argv.includes("--apply") ? apply(runRoot, found) : null;
  const exit = done?.kept.length ? 1 : 0;
  if (argv.includes("--json")) return { exit, out: JSON.stringify({ ...found, applied: done }) };
  return { exit, out: render(found, done) };
}

function render(found, done) {
  const lines = [done ? "sweep (applied)" : "sweep (dry run: nothing changed; --apply to act)"];
  // Paths and command lines are shown whole: cutting one would hide what is about to be stopped.
  const row = (text) => lines.push(`  ${text}`);
  for (const w of found.cleanable) {
    const kept = done?.kept.find((k) => k.id === w.id);
    const verb = !done ? "would remove" : kept ? "kept" : "removed";
    row(`${verb} worktree ${w.id} (merged)${kept ? `: ${kept.reason}` : ""}`);
  }
  for (const w of found.unknown) row(`unknown worktree ${w.path} (left alone)`);
  for (const p of found.strays) {
    const verb = !done ? "would stop" : done.killed.includes(p.pid) ? "stopped" : "already gone:";
    row(`${verb} process ${p.pid}  ${p.command}`);
  }
  for (const w of found.warnings) row(`warning: ${w}`);
  if (lines.length === 1) row("nothing to clean");
  return lines.join("\n");
}
