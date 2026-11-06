// lane sweep [--apply [--discard-ignored]] [--json] — clean up after a session. Without
// `--apply` it only reports: the worktrees of merged or closed tasks, the worktrees no ledger knows (never
// removed), the processes left running under `.agentry/run/` by a finished lane or by none (an interactive
// shell among them is listed as left alone, never stopped), what killed writers and holders left (temp files
// whose writer is gone, lock and gate slots whose holder and riders are gone with each pgid they left running,
// stale write-locks), and a low-disk or no-lsof warning. With `--apply` it stops those processes (each with
// its descendants) and those groups, frees those slots, removes those files and the worktrees, and nothing
// else; a worktree holding ignored files (`.env`, screenshots) stays unless `--discard-ignored`. Build
// output (`node_modules`, `dist`, and the process file's `cleanup.disposable`) is discarded without asking.
// Needs no process file: without one, only the defaults are disposable.
// Exit 0 = done or reported, 1 = `--apply` left a worktree it could not remove, a process or group running,
// or a slot held.
//
// run(argv, { root }) -> { exit, out }
import { existsSync } from "node:fs";
import { mainRoot } from "../../process/git.mjs";
import { loadSpec } from "../../process/read.mjs";
import { apply, keepReason, plan } from "../sweep.mjs";

export const help = {
  usage: "sweep [--apply [--discard-ignored]] [--json]",
  purpose:
    "Clean up after a session: finished lanes' worktrees, the processes left running, and dead writers' and holders' files.",
  args: {},
  flags: {
    "--apply":
      "stop those processes and groups, free those slots, remove those files and worktrees (without it: only report)",
    "--discard-ignored": "with --apply: also remove a worktree that holds ignored files",
    "--json": "print { applied, …the plan, result } (result: what --apply did, else null)",
  },
  exits: { 0: "done or reported", 1: "--apply left a worktree, a process or a slot" },
  example: "lane sweep --apply",
};
export const noSpec = true;

// The configured `cleanup.disposable`, only from a spec that loaded clean and holds a list of strings;
// anything else is `[]` (the defaults still apply) and `note` says why, so a bad config never stops a sweep.
function disposableOf({ spec, problems }, processPath) {
  if (problems.length > 0) {
    if (!existsSync(processPath)) return { globs: [] }; // no process file: nothing was configured
    const [{ message, file }] = problems;
    return { globs: [], note: `${message} (${file ?? processPath})` };
  }
  const value = spec?.cleanup?.disposable;
  if (value === undefined) return { globs: [] };
  if (Array.isArray(value) && value.every((glob) => typeof glob === "string"))
    return { globs: value };
  return { globs: [], note: `it is not a list of strings (${processPath})` };
}

export function run(argv, { root, processPath }) {
  const runRoot = mainRoot(root) ?? root;
  const { globs, note } = disposableOf(loadSpec(processPath, { root }), processPath);
  const found = plan(runRoot, { disposable: globs });
  const discardIgnored = argv.includes("--discard-ignored");
  const done = argv.includes("--apply") ? apply(runRoot, found, { discardIgnored }) : null;
  const exit = done?.kept.length || done?.survived.length || done?.keptSlots.length ? 1 : 0;
  if (argv.includes("--json"))
    return { exit, out: JSON.stringify({ applied: Boolean(done), ...found, result: done }) };
  return { exit, out: render(found, done, discardIgnored, note) };
}

function render(found, done, discardIgnored, note) {
  const lines = [done ? "sweep (applied)" : "sweep (preview: nothing changed; add --apply to act)"];
  // Paths and command lines are shown whole: cutting one would hide what is about to be stopped.
  const row = (text) => lines.push(`  ${text}`);
  if (note) row(`! cleanup.disposable ignored: ${note}`);
  for (const w of found.cleanable) {
    const kept = done?.kept.find((k) => k.id === w.id);
    const why = kept ? kept.reason : keepReason(w, discardIgnored);
    const verb = !done ? (why ? "would keep" : "would remove") : kept ? "kept" : "removed";
    const thrown = w.disposable?.length ?? 0;
    const discard =
      !why && thrown
        ? ` (${done ? "discarded" : "would discard"} ${thrown} disposable path(s))`
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
  leftoverRows(found, done, row);
  if (done?.signalled.length) row(`signalled: ${done.signalled.join(", ")}`);
  if (done?.survivors.length) row(`still running after SIGKILL: ${done.survivors.join(", ")}`);
  for (const w of found.warnings) row(`warning: ${w}`);
  if (lines.length === 1) row("nothing to clean");
  return lines.join("\n");
}

// The rows of what killed writers and holders left: each slot with the groups it left running, the stale
// write-locks and the temp files.
function leftoverRows(found, done, row) {
  for (const s of found.slots) {
    const name = s.lock === "gate" ? `gate slot ${s.slot}` : `lock ${s.lock} slot ${s.slot}`;
    const kept = done?.keptSlots.find((k) => k.file === s.file);
    const verb = !done ? "would free" : kept ? "kept" : "freed";
    row(`${verb} ${name}: its holder is gone${kept ? `; ${kept.reason}` : ""}`);
    for (const pgid of s.groups) {
      const state = !done
        ? "still running: would stop"
        : done.survivingGroups.includes(pgid)
          ? "STILL RUNNING"
          : "stopped";
      row(`  group ${pgid} ${state}`);
    }
  }
  // What came back to life or was taken over since the preview is left, and said so.
  const verb = (file, gone) => (!done ? "would remove" : gone.includes(file) ? "removed" : "left");
  for (const file of found.writeLocks)
    row(`${verb(file, done?.removedWriteLocks)} stale write-lock ${file}`);
  for (const file of found.temps)
    row(`${verb(file, done?.removedTemps)} temp file ${file}: its writer is gone`);
}
