// steps — the Steps part of a contract block (field 48): numbered steps the lane builds in runs, the
// owner's gates between them, and the acceptance items tagged to each step. PURE: no imports, no I/O.
//
// The part opens at a `**Steps:**` / `**Steps**:` label or a `Steps` heading of any level and holds one
// numbered item per line (`1.` or `1)`); a more indented line joins the item above; it ends at the next
// bold label or heading. An item ending `→ owner OK` or `-> owner OK` (any case, optional period) has an
// owner gate. Under the Acceptance label or heading, a list item that starts `Step N:` is step N's.
//
//   stepsOf(block) -> { steps: [{ n, text, gate: "owner" | null, accept: [text] }], problem }
//   runOf(steps, from) -> [from, g]   g: the first step from `from` with an owner gate, else the last
//   runText([a, g], total) -> "step 1 of 2" | "steps 2–3 of 3"

// A bold run that opens a line (after an optional bullet) is a label; a numbered item is not.
const LABEL = /^\s*(?:[-*+]\s+)?\*\*[^*\n]+\*\*/;
const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;
const named = (word) => ({
  label: new RegExp(`^\\s*(?:[-*+]\\s+)?\\*\\*${word}(?::\\*\\*|\\*\\*:)`, "i"),
  heading: new RegExp(`^${word}\\s*:?$`, "i"),
});
const STEPS = named("steps");
const ACCEPT = named("accept(?:ance)?");
const NUMBERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const LISTED = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const GATE = /\s*(?:→|->)\s*owner\s+ok\.?\s*$/i;
const TAG = /^step\s+(\d+)\s*:\s*/i;
const FENCE = /^\s*(```|~~~)/;

const indentOf = (line) => /^\s*/.exec(line)[0].length;

// The lines of the first part `name` opens (the label or heading line left out), or null when none does.
// A bold run more indented than the list item above it is that item's text, not a label.
function partOf(lines, name) {
  let fenced = false;
  let body = null;
  let item = -1; // the indent of the last list item in the part
  for (const line of lines) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = !fenced && HEADING.exec(line);
    const opens = !fenced && (name.label.test(line) || (heading && name.heading.test(heading[1])));
    if (body === null) {
      if (opens) body = [];
      continue;
    }
    const label = LABEL.test(line) && (item < 0 || indentOf(line) <= item);
    if (!fenced && (heading || label)) break;
    if (!fenced && LISTED.test(line)) item = indentOf(line);
    body.push(fenced || FENCE.test(line) ? "" : line);
  }
  return body;
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

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The block's steps and the one problem with them, or `{ steps: [], problem: null }` when the block
 *  has no Steps part. */
export function stepsOf(block) {
  const lines = String(block ?? "").split(/\r?\n/);
  const part = partOf(lines, STEPS);
  if (part === null) return { steps: [], problem: null };
  const steps = itemsOf(part, NUMBERED).map(({ head, text }) => ({
    n: Number(head),
    text: text.replace(GATE, "").trim(),
    gate: GATE.test(text) ? "owner" : null,
    accept: [],
  }));
  if (!steps.length)
    return { steps, problem: "the Steps part has no numbered items, one per line" };
  if (steps.some((s, i) => s.n !== i + 1))
    return {
      steps,
      problem: `steps must be numbered 1 to N with no gap (found ${steps.map((s) => s.n).join(", ")})`,
    };
  for (const { text } of itemsOf(partOf(lines, ACCEPT) ?? [], LISTED)) {
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
