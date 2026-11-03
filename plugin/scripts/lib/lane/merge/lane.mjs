// merge/lane — what every `lane merge` step shares: the lane a call works on (`{ root, spec, model, id,
// opts, ledger, … }`), its step table (rows, rendered), the ledger writes, and the next steps a call
// names. The steps (`merge/*.mjs`) take the lane and the rows so far, push their own row, and return
// null to go on or `{ exit, next?, keepCarry? }` to stop.
import { readConfig } from "../../config.mjs";
import { write as writeLedger } from "../../process/ledger.mjs";
import { commitOf } from "../land.mjs";

// The land steps from which nothing of this land is on main: a run starts the picks over.
export const FRESH = [undefined, "conflict", "rolled-back"];
const MARK = { ok: "✓", warn: "!", red: "✗", skip: "·", wait: "…" };
export const short = (sha) => (sha ? sha.slice(0, 7) : "-");
export const now = () => new Date().toISOString();
const row =
  (mark) =>
  (step, detail, more = []) => ({ step, mark, detail, more });
export const ok = row("ok");
export const warn = row("warn"); // goes on, but says something the owner should see
export const red = row("red");
export const skip = row("skip");
export const wait = row("wait");

function render(lane, rows, next) {
  const head = lane.ledger
    ? `merge ${lane.id} · ${lane.ledger.branch} → ${lane.ledger.mainBranch}`
    : `merge ${lane.id}`;
  const body = rows.flatMap((r) => [
    `  ${MARK[r.mark]} ${r.step.padEnd(7)} ${r.detail}`,
    ...r.more.map((m) => `            ${m}`),
  ]);
  return [head, ...body, ...(next ? [`next: ${next}`] : [])].join("\n");
}
/** The call's result; a next step it names is kept in the ledger too (`next`), for a cold resume. */
export function done(exit, lane, rows, next) {
  if (lane.ledger && next && lane.ledger.next !== next) save(lane, { next });
  if (lane.opts?.["--json"]) {
    const { branch, mainBranch: main } = lane.ledger ?? {};
    return { exit, out: JSON.stringify({ id: lane.id, branch, main, rows, next: next ?? null }) };
  }
  return { exit, out: render(lane, rows, next) };
}

/** Write the ledger with `changes` merged in, and keep the written copy on the lane. */
export function save(lane, changes = {}) {
  lane.ledger = writeLedger(lane.root, { ...lane.ledger, ...changes });
  return lane.ledger;
}
/** The same for the ledger's `merge` record; a key set to undefined is dropped. */
export const setMerge = (lane, changes) =>
  save(lane, { merge: { ...lane.ledger.merge, ...changes, at: now() } });

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
