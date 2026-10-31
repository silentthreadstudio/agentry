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
    if (!m) continue;
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
const ID = /^[A-Za-z]:[A-Za-z0-9][A-Za-z0-9._…-]*$/;

/** The memory ids cited under an explicit `used_memories:` line — inline (`used_memories: [p:a, g:b]`) or
 *  as a bullet list under it — de-duplicated, in order. Only tokens shaped like an id count, so words of
 *  prose after the colon never do; `none` is `[]`. */
export function usedMemories(text) {
  const lines = nonEmpty(text);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^[>#*`_\s-]*used_memories[*`_\s]*:(.*)$/i.exec(lines[i]);
    if (!m) continue;
    let rest = m[1];
    if (!rest.trim())
      for (let j = i + 1; /^[-*]\s+/.test(lines[j] ?? ""); j++)
        rest += `,${lines[j].replace(/^[-*]\s+/, "")}`;
    for (const raw of rest.split(/[,\s]+/)) {
      const id = raw.replace(/^[[("'`]+|[\])"'`.;]+$/g, "");
      if (!NO_MEMORY.has(id.toLowerCase()) && ID.test(id) && !found.includes(id)) found.push(id);
    }
  }
  return found;
}

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
    return body.length > 120 ? `${body.slice(0, 119)}…` : body;
  }
  return "";
}
