// merge/lane — what every `lane merge` step shares: the lane a call works on (`{ root, spec, model, id,
// opts, ledger, … }`), its step table (rows, rendered), the ledger writes, and the next steps a call
// names. The steps (`merge/*.mjs`) take the lane and the rows so far, push their own row, and return
// null to go on or `{ exit, next?, keepCarry? }` to stop.
import { nextStep } from "../../cli/invoke.mjs";
import { readConfig } from "../../config.mjs";
import { write as writeLedger } from "../../process/ledger.mjs";
import { identity } from "../../process/pid.mjs";
import { now } from "../fmt.mjs";
import { commitOf } from "../land.mjs";

export { now };

// The land steps from which nothing of this land is on main: a run starts the picks over.
export const FRESH = [undefined, "conflict", "rolled-back"];
const MARK = { ok: "✓", warn: "!", red: "✗", skip: "·", wait: "…" };
export const short = (sha) => (sha ? sha.slice(0, 7) : "-");
const row =
  (mark) =>
  (step, detail, more = []) => ({ step, mark, detail, more });
export const ok = row("ok");
export const warn = row("warn"); // goes on, but says something the owner should see
export const red = row("red");
export const skip = row("skip");
export const wait = row("wait");

const line = (r) => `  ${MARK[r.mark]} ${r.step.padEnd(7)} ${r.detail}`;
/** A row's first line on stderr, written as its step finishes: the table on stdout comes only at the end
 *  of the call, and a gate can run for minutes. */
export const progress = (r) => process.stderr.write(`${line(r)}\n`);

function render(lane, rows, next) {
  const head = lane.ledger
    ? `merge ${lane.id} · ${lane.ledger.branch} → ${lane.ledger.mainBranch}`
    : `merge ${lane.id}`;
  const body = rows.flatMap((r) => [line(r), ...r.more.map((m) => `            ${m}`)]);
  return nextStep([head, ...body, ...(next ? [`next: ${next}`] : [])].join("\n"));
}
/** The call's result; a next step it names is kept in the ledger too (`next`), for a cold resume. */
export function done(exit, lane, rows, next) {
  if (lane.ledger && next && lane.ledger.next !== next) save(lane, { next });
  if (lane.opts?.["--json"]) {
    const { branch, mainBranch: main } = lane.ledger ?? {};
    return {
      exit,
      out: JSON.stringify({ id: lane.id, branch, main, rows, next: next ? nextStep(next) : null }),
    };
  }
  return { exit, out: render(lane, rows, next) };
}

/** Write the ledger with `changes` merged in, and keep the written copy on the lane. */
export function save(lane, changes = {}) {
  lane.ledger = writeLedger(lane.root, { ...lane.ledger, ...changes });
  return lane.ledger;
}
/** The process running this land as the ledger names it, `{ pid, start, at }` (`at`: when this process took
 *  the land, kept while it is the one writing), so `landInProgress` can tell a land that runs from one a
 *  kill left. */
export function holderOf(lane) {
  const held = lane.ledger.merge?.holder;
  const me = identity();
  return held?.pid === me.pid && held.start === me.start ? held : { ...me, at: now() };
}
/** A land resumed takes the record over: its process is the holder from here on, whatever wrote it before.
 *  Nothing is written when this process already holds it, or no land is under way. */
export function claim(lane) {
  const { state, merge } = lane.ledger;
  if (state !== "merging" || !merge) return;
  const mine = holderOf(lane);
  if (merge.holder !== mine) save(lane, { merge: { ...merge, holder: mine } });
}
/** The same for the ledger's `merge` record; a key set to undefined is dropped. Every write of a land not
 *  yet merged names the process doing it, from the set-aside on. */
export const setMerge = (lane, changes) =>
  save(lane, {
    merge: {
      ...lane.ledger.merge,
      ...(lane.ledger.state !== "merged" && { holder: holderOf(lane) }),
      ...changes,
      at: now(),
    },
  });

/** The branch's current tip. */
export const tipOf = (lane) => commitOf(lane.root, `refs/heads/${lane.ledger.branch}`);

export const landNext = (id) =>
  `lane merge ${id} --message "<board commit message>" [--summary "<handoff text>"]`;
export const checkNext = (id, names) =>
  names.map((name) => `lane merge ${id} --check ${name}=pass|fail [--note "<why>"]`).join("; ");

/** What comes after a land: the push the policy allows, else the cleanup. */
export function afterLand(lane) {
  const { id, root, ledger } = lane;
  if (ledger.merge?.cleaned?.removed) return null;
  if (ledger.merge?.pushed) return `lane merge ${id} --cleanup`;
  const config = readConfig(root);
  if (config.error) return `fix the config (${config.error}), then lane merge ${id} --push`;
  if (config.merge.push === "auto") return `lane merge ${id} --push`;
  if (config.merge.push === "ask")
    return `ask the owner to push ${ledger.mainBranch}; on yes: lane merge ${id} --push --approved`;
  return `lane merge ${id} --cleanup (merge.push is "never": the owner pushes)`;
}
