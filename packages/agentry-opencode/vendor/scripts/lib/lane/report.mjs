// report — reading what a dispatched agent sent back. Pure: text in, facts out. No I/O, no throwing.
//
// A report reaches the conductor wrapped by the host (opencode V2 `<subagent …>`, V1 `<task …><task_result>`),
// or bare (Claude Code). `unwrap` removes the wrapper; the readers below then work on the same text on every
// host. The `agentry-task:` marker may sit on line 2 (opencode V2 prefixes its own line to the prompt), so
// `findMarker` looks at the first few lines, not just the first.
//
//   builderStatus  one of DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED, in the first 5 non-empty lines
//   verdictOf      `Verdict: PASS | PASS WITH NOTES | FAIL`, and only as the LAST non-empty line
//   usedMemories   the ids a builder cites in `used_memories`
//   summaryOf      one line, ≤ 120 chars, for the ledger and the handoff
//   nextListOf     the list under a report's own `Next` heading or label, as plain items
import { idProblem } from "../id.mjs";

const WRAPPER = /<\/?(?:subagent|task|task_result|text)(?:\s[^>]*)?>/g;

// Decoration around a line that is not part of its meaning: markdown emphasis, code ticks, quote marks.
const strip = (line) => line.replace(/^[\s>#*`_-]+/, "").replace(/[\s*`_]+$/, "");

const nonEmpty = (text) =>
  unwrap(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** The text without the host's wrapper tags (`<subagent …>`, `</subagent>`, `<text>`, `<task …>`,
 *  `<task_result>` and their closers), wherever they sit on a line. */
export function unwrap(text) {
  return String(text ?? "")
    .replace(WRAPPER, "\n")
    .replace(/\r\n?/g, "\n");
}

/** The `agentry-task: <id> role=<role> [round=<n>]` line within the first `within` non-empty lines:
 *  `{ id, role, round? }`, or null. `role` is null when the line names none. */
export function findMarker(text, { within = 5 } = {}) {
  for (const line of nonEmpty(text).slice(0, within)) {
    const m = /^agentry-task:\s*([A-Za-z0-9][A-Za-z0-9._-]*)(.*)$/.exec(strip(line));
    if (!m || idProblem(m[1])) continue;
    const role = /\brole=([a-z-]+)/.exec(m[2])?.[1] ?? null;
    const round = /\bround=(\d+)/.exec(m[2])?.[1];
    return { id: m[1], role, ...(round !== undefined && { round: Number(round) }) };
  }
  return null;
}

const STATUS =
  /^(?:[Ss]tatus\s*:\s*)?[*`]*(DONE_WITH_CONCERNS|DONE|NEEDS_CONTEXT|BLOCKED)(?![A-Za-z0-9_])/;

/** The builder's status token: the first of the first 5 non-empty lines that starts with one. */
export function builderStatus(text) {
  for (const line of nonEmpty(text).slice(0, 5)) {
    const m = STATUS.exec(strip(line));
    if (m) return m[1];
  }
  return null;
}

/** The verdict, read from the LAST non-empty line only and only in the exact form `Verdict: <word>`. A
 *  verdict anywhere else, or followed by prose, is not one. */
export function verdictOf(text) {
  const last = nonEmpty(text).at(-1);
  if (!last) return null;
  const m = /^Verdict:\s*(PASS WITH NOTES|PASS|FAIL)$/.exec(last.replace(/^[*`]+|[*`]+$/g, ""));
  return m ? m[1] : null;
}

const NO_MEMORY = new Set(["", "none", "n/a", "na", "null", "-", "no"]);
// A memory id is `<kind>:<id>` (`p:01ABC`, `g:xyz`); anything else on the line is prose.
// A truncated id (one ending in `…`) names nothing, so `…` is not allowed in it.
const ID = /^[A-Za-z]:[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ITEM = /^(?:[-*]|\d+[.)])\s+/;

/** The memory ids cited under an explicit `used_memories:` line — inline (`used_memories: [p:a, g:b]`) or
 *  as a bullet or numbered list, or a JSON array across lines, under it — de-duplicated, in order. Only tokens shaped like an id count, so words of
 *  prose after the colon never do; `none` is `[]`. */
export function usedMemories(text) {
  const lines = nonEmpty(text);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^[>#*`_\s-]*used_memories[*`_\s]*:(.*)$/i.exec(lines[i]);
    if (!m) continue;
    let rest = m[1];
    if (!rest.trim())
      for (let j = i + 1; ITEM.test(lines[j] ?? ""); j++) rest += `,${lines[j].replace(ITEM, "")}`;
    else if (rest.includes("[") && !rest.includes("]"))
      for (let j = i + 1; j < lines.length && !rest.includes("]"); j++) rest += `,${lines[j]}`;
    for (const raw of rest.split(/[,\s]+/)) {
      const id = raw.replace(/^[[("'`]+|[\])"'`.;]+$/g, "");
      if (!NO_MEMORY.has(id.toLowerCase()) && ID.test(id) && !found.includes(id)) found.push(id);
    }
  }
  return found;
}

/** How much of a summary longer than one line's 120 characters is kept, before the "…" (`summaryOf`). */
export const SUMMARY_CUT = 119;

/** One line (≤ 120 chars) saying what the report is about: the text after the status token when it has
 *  some, else the first line that is not the marker, a bare status, a verdict or a heading. */
export function summaryOf(text) {
  for (const line of nonEmpty(text)) {
    const bare = strip(line);
    if (!bare || /^agentry-task:/.test(bare) || /^Verdict:/.test(bare)) continue;
    const body = bare
      .replace(STATUS, "")
      .replace(/^[\s:.—–-]+/, "")
      .trim();
    if (!body || (/^#/.test(line) && !/\w+\s+\w+/.test(body))) continue;
    return body.length > SUMMARY_CUT + 1 ? `${body.slice(0, SUMMARY_CUT)}…` : body;
  }
  return "";
}

const NEXT_LABEL = /^[\s>#*`_-]*next(?:\s+(?:steps?|list|up|actions?))?[\s*`_]*:?[\s*`_]*$/i;
/** How many items of a report's next list are kept. */
export const NEXT_CAP = 10;

/** The items of the list under the report's `Next` heading or label (a line holding only that word, or
 *  `Next steps`, `Next list`), as text without the bullet or number: the list ends at the first line that
 *  is neither an item nor an item's indented continuation, at most `NEXT_CAP` items. `[]` when the report
 *  has no such label or nothing under it. */
export function nextListOf(text) {
  const lines = unwrap(text).split("\n");
  const at = lines.findIndex((l) => NEXT_LABEL.test(l));
  if (at < 0) return [];
  const items = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.trim()) {
      if (items.length) break;
      continue;
    }
    if (ITEM.test(line.trim())) items.push(line.trim().replace(ITEM, ""));
    else if (items.length && /^\s{2,}\S/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
    else break;
  }
  return items.slice(0, NEXT_CAP);
}
