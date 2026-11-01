// gate-group — the merge gate's process group across a killed run (plan R1b-5). `lane merge` runs the
// gate under a wrapper that writes its own pid (the group's id) to a file the ledger names, with a nonce
// in its argv; a rerun finds the group by that file and stops it, unless the pid now belongs to another
// process. Node built-ins only.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// The gate runs under this wrapper: it writes its own pid to `pidFile`, then runs the gate as its
// child. `runGate` starts it detached, so the wrapper leads the group the gate runs in and its pid is
// the group's id. A merge killed mid-gate leaves that group running; the next run finds it by the file.
const WRAP = `const [, pidFile, ...cmd] = process.argv.slice(1);
require("node:fs").writeFileSync(pidFile, String(process.pid));
const r = require("node:child_process").spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
if (r.error) { console.error("[agentry] could not run " + cmd[0] + ": " + r.error.message); process.exit(127); }
process.exit(r.status ?? 1);`;

/** The argv that runs the gate `cmd` under the pid-writing wrapper. `nonce` sits in the wrapper's own
 *  argv, so a later run can tell the group is this gate's and not a process that reused the pid. */
export function gateArgv(cmd, { pidFile, nonce }) {
  return [process.execPath, "-e", WRAP, nonce, pidFile, ...cmd];
}

const alive = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM"; // there, but not ours to signal
  }
};

/**
 * End the gate a killed run left behind (`run` = `{ pidFile, nonce }`, as the ledger recorded it).
 * `{ ok: true, pgid, killed }` (`killed`: a group was still running and is gone now), or `{ ok: false,
 * pgid, reason }` when the group will not die. A live group is the gate's when its leader's argv holds
 * the nonce, or when it has no leader left (a live group's id is never reused); one whose leader is
 * another process is left alone.
 */
export function endStrayGate(run) {
  let pgid;
  try {
    pgid = Number.parseInt(readFileSync(run.pidFile, "utf8").trim(), 10);
  } catch {
    return { ok: true, pgid: null, killed: false }; // the wrapper never started
  }
  if (!Number.isInteger(pgid) || pgid <= 1 || !alive(pgid))
    return { ok: true, pgid, killed: false };
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(pgid)], { encoding: "utf8" });
  if (ps.error)
    return {
      ok: false,
      pgid,
      reason: `ps cannot say what process ${pgid} is: ${ps.error.message}`,
    };
  const leader = ps.status === 0 ? ps.stdout.trim() : "";
  if (leader && !leader.includes(run.nonce)) return { ok: true, pgid, killed: false }; // a reused pid
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error) {
    return { ok: false, pgid, reason: `cannot kill process group ${pgid}: ${error.code}` };
  }
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; waited < 5000 && alive(pgid); waited += 20) Atomics.wait(nap, 0, 0, 20);
  if (alive(pgid)) return { ok: false, pgid, reason: `process group ${pgid} is still running` };
  return { ok: true, pgid, killed: true };
}
