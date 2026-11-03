// exec-view — the readable form of a `lane exec` step's result (the same fields `--json` prints, same
// names, same order): a header line, then one `key: value` per field; a multi-line text (the prompt) or
// an object is indented under its key; `idle` is its one line. Also the words a held lane and an idle one
// are shown in, which `lane session start` prints too. PURE.
//
// humanView(result) -> string
// heldText(hold, total) -> string      the `held:` line's text (`total`: the contract's steps, 0 for none)
// holdWhere(hold, total) -> string     `after step 1 of 2`, `during steps 2–3 of 3`, `mid-build`
// answerLine(entry, total) -> string   one owner's answer: `approved: step 1 of 2 at <ISO>: "<note>"`
// idleText(id, idle) -> string         the `idle:` line's text (field 53)
// clock(iso) -> "HH:MM"                local time
import { runText } from "../process/steps.mjs";

/** The verify route a lane runs, as one line (`route` is the ledger's `{ verify, flagged }`). */
export function routeText(route) {
  const verify = route?.verify ?? "all";
  if (verify === "all") return "all: every item has a verifier";
  if (route.flagged) return `${verify}: this item is flagged, so a verifier reads it`;
  const why = verify === "none" ? "no verifier" : "this item is not flagged, so no verifier";
  return `${verify}: ${why}; built goes straight to the gate`;
}

/** Where a hold sits, as words: `after step 1 of 2`, `during steps 2–3 of 3`, or `mid-build` (no steps). */
export const holdWhere = (hold, total) =>
  hold.stepRun && total ? `${hold.when} ${runText(hold.stepRun, total)}` : "mid-build";

/** The `held:` line: `for the owner, after step 1 of 2, since <ISO> · evidence <path>`, or for a parked
 *  lane `parked, since <ISO>: "<why>"`. */
export const heldText = (hold, total) =>
  hold.for === "later"
    ? `parked, since ${hold.since}${hold.why ? `: "${hold.why}"` : ""}`
    : `for the owner, ${holdWhere(hold, total)}, since ${hold.since} · evidence ${hold.evidence}`;

/** How one owner's answer (a ledger `holds[]` entry) reads: `approved` after a run, `sent back` to redo
 *  it, `noted` after a hold during a round. */
export const answerLabel = (h) =>
  h.redo ? "sent back" : h.when === "after" ? "approved" : "noted";
/** The answer after its label: `step 1 of 2 at <ISO>: "<note>"`. */
export const answerText = (h, total) =>
  `${h.stepRun && total ? runText(h.stepRun, total) : "mid-build"} at ${h.resumedAt}: "${h.note}"`;
/** The answer as one line: `approved: step 1 of 2 at <ISO>: "<note>"`. */
export const answerLine = (h, total) => `${answerLabel(h)}: ${answerText(h, total)}`;

/** `iso` as local HH:MM, or `?`. */
export const clock = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "?"
    : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** A duration in minutes as `25m` or `2h13m`. */
export const span = (minutes) =>
  minutes < 60
    ? `${minutes}m`
    : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;

/** The idle line (field 53): `<id> 2h13m: last change 11:44 (<file>) → check the builder; <park> to park
 *  it`. `idle` is `{ minutes, lastChange, file, park }` (`file` null when the newest change is a commit). */
export const idleText = (id, idle) =>
  `${id} ${span(idle.minutes)}: last change ${clock(idle.lastChange)} (${idle.file ?? "the last commit"}) → check the builder; ${idle.park} to park it`;

const HEADER = new Set(["id", "step", "next", "state"]);
const indent = (text) =>
  String(text)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

/** An owned entry as text: the path, marked when new or ambiguous. */
export const ownedMark = (o) =>
  `${o.path}${o.new ? " (new)" : ""}${o.ambiguous ? " (ambiguous: several files have this name)" : ""}`;

// The parsed owned files: one per line, new ones marked, the way to amend them on the last line.
function ownedBlock(owned, amend) {
  const items = owned.length
    ? owned.map((o) => `  - ${ownedMark(o)}`)
    : ["  none: the contract's owns part names no path"];
  return [
    "owned files (parsed from the contract):",
    ...items,
    ...(amend ? [`  amend: ${amend}`] : []),
  ];
}

function field(key, value, result) {
  if (key === "owned" && Array.isArray(value)) return ownedBlock(value, result.amend);
  if (key === "idle" && typeof value === "object") return [`idle: ${idleText(result.id, value)}`];
  if (key === "amend" && Array.isArray(result.owned)) return [];
  if (key === "preview") return [value];
  if (Array.isArray(value) && !value.length) return [`${key}: none`];
  if (typeof value === "string")
    return value.includes("\n") ? [`${key}:`, indent(value)] : [`${key}: ${value}`];
  if (value !== null && typeof value === "object")
    return [`${key}:`, indent(JSON.stringify(value, null, 2))];
  return [`${key}: ${value}`];
}

/** `result` (the object a step prints under `--json`) as text. */
export function humanView(result) {
  const state = result.state ? ` (${result.state})` : "";
  const lines = [`${result.id} · ${result.step} → ${result.next || "nothing"}${state}`];
  for (const [key, value] of Object.entries(result))
    if (!HEADER.has(key) && value !== null && value !== undefined)
      lines.push(...field(key, value, result));
  return lines.join("\n");
}
