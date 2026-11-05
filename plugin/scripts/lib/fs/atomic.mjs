// atomic — the one way Agentry writes a file whole: the text goes to `<file>.agentry-<pid>.tmp` beside it,
// which is then renamed over the file, so a reader sees the old text or the new, never a part. A writer killed
// between the two leaves its temp file behind; `sweepTemps` removes those whose pid no longer runs (a live
// writer's is never touched). Node built-ins only.
import { chmodSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { running } from "../process/pid.mjs";

const TEMP = /\.agentry-(\d+)\.tmp$/;

/** The temp name this process writes `file` under before renaming it in. */
export const tempOf = (file) => `${file}.agentry-${process.pid}.tmp`;

/** Write `text` to `file` whole: a temp file beside it, renamed over it. The temp never outlives a failure.
 *  A file it replaces keeps its permission bits, as an in-place write would. */
export function atomicWrite(file, text) {
  const tmp = tempOf(file);
  try {
    writeFileSync(tmp, text);
    const mode = modeOf(file);
    if (mode !== null) chmodSync(tmp, mode);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** `file`'s permission bits, or null when it is not there to keep them from. */
function modeOf(file) {
  try {
    return statSync(file).mode & 0o7777;
  } catch {
    return null;
  }
}

/** The temp files in `dir` whose writer is gone (paths; `[]` when `dir` is missing). `match` also counts
 *  another naming's leftovers: its first group must be the writer's pid. */
export function deadTemps(dir, match = TEMP) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      const pid = (match.exec(name) ?? TEMP.exec(name))?.[1];
      return pid !== undefined && !running(Number(pid));
    })
    .map((name) => join(dir, name));
}

/** Remove the temp files in `dir` whose writer is gone: the paths it removed. */
export function sweepTemps(dir, match = TEMP) {
  const dead = deadTemps(dir, match);
  for (const file of dead) rmSync(file, { force: true });
  return dead;
}
