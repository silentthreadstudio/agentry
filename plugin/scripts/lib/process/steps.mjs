// steps — the Steps part of a contract block (field 48): numbered steps the lane builds in runs, the
// owner's gates between them, and the acceptance items tagged to each step. PURE: no I/O.
//
// The part opens at a `**Steps:**` / `**Steps**:` label or a `Steps` heading of any level and holds one
// numbered item per line (`1.` or `1)`); a more indented line joins the item above; it ends at the next
// bold label or heading. A label followed on its own line by `1. ` lists the steps inline: that is a
// problem, never parsed, and its words carry a best-effort rewrite, one step per line (field 96). An item
// ending `→ owner OK`, `-> owner OK` or `— owner OK` (any case, optional period, `**owner OK**`, a trailing
// `(note)` kept as the step's `note`) has an owner gate; a step that talks of an owner gate but ends
// with none is a problem; one ending
// `(model: <m>, agent: <a>)` (either key, either order, before or after the gate, any case, each value one
// word) names its builder; the steps of one run must not name two models or two agents. Under the
// Acceptance label or heading, a list item that starts `Step N:` is step N's.
//
//   stepsOf(block) -> { steps: [{ n, text, gate: "owner" | null, accept: [text], model?, agent? }], problem }
//   runOf(steps, from) -> [from, g]   g: the first step from `from` with an owner gate, else the last
//   runMark(steps, stepRun, key) -> { value, from: "step N" } | null   the run's first step naming `key`
//   runText([a, g], total) -> "step 1 of 2" | "steps 2–3 of 3"
import { maskFences } from "./markdown.mjs";

// A bold run that opens a line (after an optional bullet) is a label; a numbered item is not.
const LABEL = /^\s*(?:[-*+]\s+)?\*\*[^*\n]+\*\*/;
const INLINE = /^1\.\s/;
const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;
const named = (word) => ({
  label: new RegExp(`^\\s*(?:[-*+]\\s+)?\\*\\*${word}(?::\\*\\*|\\*\\*:)`, "i"),
  heading: new RegExp(`^${word}\\s*:?$`, "i"),
});
const STEPS = named("steps");
const ACCEPT = named("accept(?:ance)?");
const NUMBERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const LISTED = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
// The gate: an arrow or dash, `owner OK` (bold or not), an optional period, an optional `(note)` that is
// not a `(model: …)` / `(agent: …)` marker.
const GATE =
  /\s*(?:→|->|—|–)\s*(?:\*\*\s*owner\s+ok\s*\*\*|owner\s+ok)\.?(?:\s*\((?!\s*(?:model|agent)\s*:)([^()]*)\))?\.?\s*$/i;
// A step that names the owner next to a gate word but did not parse as a gate.
const OWNER = /\bowners?\b/i;
const GATE_WORD =
  /\b(?:ok|okay|reviews?|reviewed|approve[sd]?|approval|sign-?offs?|signs? off|signed off|gate)\b/i;
const MARK = /\s*\(\s*((?:model|agent)\s*:[^()]*)\)\s*$/i;
const AGENTS = ["designer", "implementer"];
const TAG = /^step\s+(\d+)\s*:\s*/i;

const indentOf = (line) => /^\s*/.exec(line)[0].length;

// The first part `name` opens: `{ head, body, indent }`, `head` the rest of a label's line ("" after a
// heading), `body` the lines after it, `indent` the opening line's; null when none opens. A bold run more
// indented than the list item above it is that item's text, not a label. `lines` have their fences
// blanked (`maskFences`), so code opens, ends and holds nothing.
function partOf(lines, name) {
  let body = null;
  let head = "";
  let indent = 0;
  let item = -1; // the indent of the last list item in the part
  for (const line of lines) {
    const heading = HEADING.exec(line);
    const opens = name.label.exec(line);
    if (body === null) {
      if (opens) head = line.slice(opens[0].length).trim();
      if (opens || (heading && name.heading.test(heading[1]))) body = [];
      if (body) indent = indentOf(line);
      continue;
    }
    const label = LABEL.test(line) && (item < 0 || indentOf(line) <= item);
    if (heading || label) break;
    if (LISTED.test(line)) item = indentOf(line);
    body.push(line);
  }
  return body && { head, body, indent };
}

// The items `pattern` matches in `lines`, a more indented line joined to the item above:
// `{ indent, head, text }` (`head` the first capture after the indent).
function itemsOf(lines, pattern) {
  const items = [];
  for (const line of lines) {
    const m = pattern.exec(line);
    if (m) items.push({ indent: m[1].length, head: m[2], text: (m[3] ?? m[2]).trim() });
    else if (line.trim() && items.length && indentOf(line) > items.at(-1).indent)
      items.at(-1).text += ` ${line.trim()}`;
  }
  return items;
}

// The rewrite an inline Steps part is flagged with, one `<n>. <text>` per line, gates and markers kept as
// written: its paragraph (`head` and the body up to a blank line or a list item at or left of the label's
// `indent`) cut at ` 2. `, then ` 3. `, …, outside code spans. A hint for the human, never parsed.
function rewriteOf(head, body, indent) {
  const end = body.findIndex(
    (line) => !line.trim() || (LISTED.test(line) && indentOf(line) <= indent),
  );
  const text = [head, ...body.slice(0, end < 0 ? body.length : end)]
    .map((line) => line.trim())
    .join(" ")
    .replace(/^1\.\s+/, "");
  const masked = text.replace(/``.*?``|`[^`]*`/g, (span) => "x".repeat(span.length));
  const items = [];
  let from = 0;
  for (let n = 2; ; n++) {
    const cut = new RegExp(`\\s${n}\\.\\s+`, "g");
    cut.lastIndex = from;
    const m = cut.exec(masked);
    if (!m) break;
    items.push(text.slice(from, m.index));
    from = m.index + m[0].length;
  }
  items.push(text.slice(from));
  return items.map((item, i) => `  ${i + 1}. ${item.trim()}`).join("\n");
}

// A marker's `key: value` pairs, both in lower case, backticks dropped.
const pairsOf = (mark) =>
  mark.split(",").map((pair) => {
    const at = pair.indexOf(":");
    const word = (w) => w.trim().replace(/`/g, "").toLowerCase();
    return at < 0 ? [word(pair), ""] : [word(pair.slice(0, at)), word(pair.slice(at + 1))];
  });

// A step's text with its owner gate and its `(model: …, agent: …)` marker cut from its end, either first:
// `{ step, problem }`, the problem a marker value that is not one word.
function stepOf(n, raw) {
  let text = raw;
  let gate = null;
  let note = null;
  let marks = null;
  for (let pass = 0; pass < 2; pass++) {
    const found = !gate && GATE.exec(text);
    if (found) {
      gate = "owner";
      note = found[1]?.trim() || null;
      text = text.slice(0, found.index);
    }
    const mark = !marks && MARK.exec(text);
    if (!mark) continue;
    marks = pairsOf(mark[1]);
    text = text.slice(0, mark.index);
  }
  const step = { n, text: text.trim(), gate, accept: [] };
  if (note) step.note = note;
  let problem = null;
  for (const [key, value] of marks ?? []) {
    if (!["model", "agent"].includes(key) || !value) continue;
    if (/\s/.test(value))
      problem ??= `step ${n}'s marker names ${key} "${value}": a marker value is one word, and its keys are split by a comma`;
    else step[key] = value;
  }
  return { step, problem };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The first run whose steps name two different values for a marker key, as the problem; else null.
function disagreement(steps) {
  for (let from = 1; from <= steps.length; ) {
    const [a, g] = runOf(steps, from);
    const run = steps.slice(a - 1, g);
    for (const key of ["model", "agent"]) {
      const [first, ...rest] = run.filter((s) => s[key]);
      const other = rest.find((s) => s[key] !== first[key]);
      if (other)
        return `steps ${first.n} and ${other.n} are built in one round but name different ${key}s (${first[key]}, ${other[key]}): put an owner gate between them or name one ${key}`;
    }
    from = g + 1;
  }
  return null;
}

/** The block's steps and the one problem with them, or `{ steps: [], problem: null }` when the block
 *  has no Steps part. */
export function stepsOf(block) {
  const lines = maskFences(String(block ?? "")).split(/\r?\n/);
  const part = partOf(lines, STEPS);
  if (part === null) return { steps: [], problem: null };
  if (INLINE.test(part.head))
    return {
      steps: [],
      problem: `the Steps part lists its steps inline: put each step on its own line\n${rewriteOf(part.head, part.body, part.indent)}`,
    };
  const parsed = itemsOf(part.body, NUMBERED).map(({ head, text }) => stepOf(Number(head), text));
  const steps = parsed.map((p) => p.step);
  if (!steps.length)
    return { steps, problem: "the Steps part has no numbered items, one per line" };
  if (steps.some((s, i) => s.n !== i + 1))
    return {
      steps,
      problem: `steps must be numbered 1 to N with no gap (found ${steps.map((s) => s.n).join(", ")})`,
    };
  const marker = parsed.find((p) => p.problem)?.problem;
  if (marker) return { steps, problem: marker };
  const odd = steps.find((s) => s.agent && !AGENTS.includes(s.agent));
  if (odd)
    return {
      steps,
      problem: `step ${odd.n} names agent ${odd.agent}; a step's agent is ${AGENTS.join(" or ")}`,
    };
  const split = disagreement(steps);
  if (split) return { steps, problem: split };
  for (const { text } of itemsOf(partOf(lines, ACCEPT)?.body ?? [], LISTED)) {
    const tag = TAG.exec(text);
    if (!tag) continue;
    const step = steps[Number(tag[1]) - 1];
    if (!step)
      return {
        steps,
        problem: `acceptance names step ${tag[1]}; the contract has ${plural(steps.length, "step")}`,
      };
    step.accept.push(text.slice(tag[0].length).trim());
  }
  const talk = steps.find((s) => !s.gate && OWNER.test(s.text) && GATE_WORD.test(s.text));
  if (talk)
    return {
      steps,
      problem: `step ${talk.n} mentions an owner gate but does not end with "→ owner OK": write it as "… → owner OK"`,
    };
  return { steps, problem: null };
}

/** The run that starts at step `from`: `[from, g]`, g the first step from `from` with an owner gate, else
 *  the last step. */
export const runOf = (steps, from) => [
  from,
  steps.find((s) => s.n >= from && s.gate === "owner")?.n ?? steps.length,
];

/** A run as words: `step 1 of 2`, `steps 2–3 of 3`. */
export const runText = ([a, g], total) =>
  a === g ? `step ${a} of ${total}` : `steps ${a}–${g} of ${total}`;

/** The marker `key` ("model" or "agent") for the run `stepRun` (`[a, g]`): the first step of the run that
 *  names one, as `{ value, from: "step N" }`; null without a run or a marked step. */
export function runMark(steps, stepRun, key) {
  if (!stepRun || !steps?.length) return null;
  const step = steps.slice(stepRun[0] - 1, stepRun[1]).find((s) => s[key]);
  return step ? { value: step[key], from: `step ${step.n}` } : null;
}
