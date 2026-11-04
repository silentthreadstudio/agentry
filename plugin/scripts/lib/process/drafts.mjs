// drafts — the owner's calls the conductor caught in conversation and has not yet written down (plan R1b §5):
// `<main root>/.agentry/run/process/drafts.jsonl`, one JSON object per line, never committed. A draft is
// `{ n, kind: "decision" | "rule", answer, why?, question?, unpicked?, source?, at, state }`. `n` is the line it
// was added on and is never reused: applying or dropping a draft changes its `state`, it does not remove
// the line. A line that is not a draft is never removed either: it is kept as written and reported
// (`unreadable`). Nothing here writes a decision or a rule; `cli/draft.mjs` does that, on the owner's OK.
//
// With `ledger`, this is the process kit's only `.agentry/run` I/O. Node built-ins only.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite, sweepTemps } from "../fs/atomic.mjs";

export const KINDS = ["decision", "rule"];
export const STATES = ["pending", "applied", "dropped"];
const TEXT = ["answer", "why", "question", "source"];
const MAX = 2000;

const fileOf = (root) => join(root, ".agentry", "run", "process", "drafts.jsonl");

/** Why `draft` (the JSON the conductor gave) is not a usable draft, or null. Unknown keys are refused. */
export function problem(draft) {
  if (draft === null || typeof draft !== "object" || Array.isArray(draft))
    return "a draft must be a JSON object";
  const allowed = ["kind", "answer", "why", "question", "unpicked", "source"];
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

// The file's text ("" when there is none) and its lines, each `{ raw, draft }`: `draft` is null for a line
// that is not a draft (torn, hand-edited), which is kept as written. The temp files a killed rewrite left
// are swept first.
function read(root) {
  sweepTemps(dirname(fileOf(root)));
  let text;
  try {
    text = readFileSync(fileOf(root), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { text: "", lines: [] };
    throw err;
  }
  const lines = text
    .split("\n")
    .filter(Boolean)
    .map((raw) => {
      try {
        const d = JSON.parse(raw);
        const ok = Number.isInteger(d?.n) && KINDS.includes(d.kind) && STATES.includes(d.state);
        return { raw, draft: ok ? d : null };
      } catch {
        return { raw, draft: null };
      }
    });
  return { text, lines };
}

/** Every draft, oldest first. A missing file is no drafts; a line that is not a draft is left out. */
export const list = (root) => read(root).lines.flatMap((l) => (l.draft ? [l.draft] : []));

/** The lines that are not drafts, by number (from 1, blank lines not counted). Never removed. */
export const unreadable = (root) => read(root).lines.flatMap((l, i) => (l.draft ? [] : [i + 1]));

/** The drafts still waiting for the owner. */
export const pending = (root) => list(root).filter((d) => d.state === "pending");

// A number a line may hold, read or not: a torn line's `"n": 7` still counts. Never reused.
const numbersIn = ({ raw, draft }) =>
  draft ? [draft.n] : [...raw.matchAll(/"n"\s*:\s*(\d+)/g)].map((m) => Number(m[1]));

/** Append `draft` (already `problem`-free) as the next `n`: past every number in the file, torn lines
 *  included, and past the line count; returns the stored draft. */
export function add(root, draft) {
  const { text, lines } = read(root);
  const n = Math.max(lines.length, ...lines.flatMap(numbersIn)) + 1;
  const stored = { n, ...draft, at: new Date().toISOString(), state: "pending" };
  mkdirSync(dirname(fileOf(root)), { recursive: true });
  // A torn last line has no newline: the new draft must not be glued onto it.
  const gap = text && !text.endsWith("\n") ? "\n" : "";
  appendFileSync(fileOf(root), `${gap}${JSON.stringify(stored)}\n`);
  return stored;
}

/** Move draft `n` to `state` (rewritten atomically, every other line as it was); returns it, or null when
 *  there is no such draft. `patch` is merged into the draft first: an apply that edits the answer or the why
 *  stores the new text and, as `edited`, the text it replaced. */
export function mark(root, n, state, patch = {}) {
  const { lines } = read(root);
  const found = lines.find((l) => l.draft?.n === n);
  if (!found) return null;
  Object.assign(found.draft, patch);
  found.draft.state = state;
  found.raw = JSON.stringify(found.draft);
  atomicWrite(fileOf(root), `${lines.map((l) => l.raw).join("\n")}\n`);
  return found.draft;
}
