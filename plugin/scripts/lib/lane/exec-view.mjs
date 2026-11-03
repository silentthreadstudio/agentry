// exec-view — the readable form of a `lane exec` step's result (the same fields `--json` prints, same
// names, same order): a header line, then one `key: value` per field; a multi-line text (the prompt) or
// an object is indented under its key. PURE.
//
// humanView(result) -> string

/** The verify route a lane runs, as one line (`route` is the ledger's `{ verify, flagged }`). */
export function routeText(route) {
  const verify = route?.verify ?? "all";
  if (verify === "all") return "all: every item has a verifier";
  if (route.flagged) return `${verify}: this item is flagged, so a verifier reads it`;
  const why = verify === "none" ? "no verifier" : "this item is not flagged, so no verifier";
  return `${verify}: ${why}; built goes straight to the gate`;
}

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
