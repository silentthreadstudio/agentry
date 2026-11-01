// drafts — the owner's calls the conductor caught in conversation and has not yet written down (plan R1b §5):
// `<main root>/.agentry/run/process/drafts.jsonl`, one JSON object per line, never committed. A draft is
// `{ n, kind: "decision" | "rule", answer, question?, unpicked?, source?, at, state }`. `n` is the line it
// was added on and is never reused: applying or dropping a draft changes its `state`, it does not remove
// the line. Nothing here writes a decision or a rule; `cli/draft.mjs` does that, on the owner's OK.
//
// With `ledger`, this is the process kit's only `.agentry/run` I/O. Node built-ins only.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const KINDS = ["decision", "rule"];
export const STATES = ["pending", "applied", "dropped"];
const TEXT = ["answer", "question", "source"];
const MAX = 2000;

const fileOf = (root) => join(root, ".agentry", "run", "process", "drafts.jsonl");

/** Why `draft` (the JSON the conductor gave) is not a usable draft, or null. Unknown keys are refused. */
export function problem(draft) {
  if (draft === null || typeof draft !== "object" || Array.isArray(draft))
    return "a draft must be a JSON object";
  const allowed = ["kind", "answer", "question", "unpicked", "source"];
  const extra = Object.keys(draft).find((k) => !allowed.includes(k));
  if (extra) return `a draft has no "${extra}" (keys: ${allowed.join(", ")})`;
  if (!KINDS.includes(draft.kind)) return `kind must be one of ${KINDS.join(", ")}`;
  if (typeof draft.answer !== "string" || !draft.answer.trim()) return "answer must be some text";
  for (const key of TEXT)
    if (draft[key] !== undefined && typeof draft[key] !== "string") return `${key} must be text`;
  const open = draft.unpicked;
  if (
    open !== undefined &&
    !(typeof open === "string" || open?.every?.((o) => typeof o === "string"))
  )
    return "unpicked must be text or a list of text";
  const long = [...TEXT, "unpicked"].find((k) => JSON.stringify(draft[k] ?? "").length > MAX);
  return long ? `${long} is longer than ${MAX} characters` : null;
}

/** Every draft, oldest first. A missing file is no drafts; a line that is not a draft is left out. */
export function list(root) {
  let text;
  try {
    text = readFileSync(fileOf(root), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const line of text.split("\n").filter(Boolean)) {
    try {
      const d = JSON.parse(line);
      if (Number.isInteger(d?.n) && KINDS.includes(d.kind) && STATES.includes(d.state)) out.push(d);
    } catch {
      /* a torn or hand-edited line: skipped, the rest still read */
    }
  }
  return out;
}

/** The drafts still waiting for the owner. */
export const pending = (root) => list(root).filter((d) => d.state === "pending");

/** Append `draft` (already `problem`-free) as the next `n`; returns the stored draft. */
export function add(root, draft) {
  const n = Math.max(0, ...list(root).map((d) => d.n)) + 1;
  const stored = { n, ...draft, at: new Date().toISOString(), state: "pending" };
  mkdirSync(dirname(fileOf(root)), { recursive: true });
  appendFileSync(fileOf(root), `${JSON.stringify(stored)}\n`);
  return stored;
}

/** Move draft `n` to `state` (rewritten atomically); returns it, or null when there is no such draft. */
export function mark(root, n, state) {
  const all = list(root);
  const found = all.find((d) => d.n === n);
  if (!found) return null;
  found.state = state;
  const tmp = `${fileOf(root)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${all.map((d) => JSON.stringify(d)).join("\n")}\n`);
  renameSync(tmp, fileOf(root));
  return found;
}
