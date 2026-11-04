// steps — the Steps part of a contract block (field 48): numbered steps the lane builds in runs, the
// owner's gates between them, and the acceptance items tagged to each step. PURE: no imports, no I/O.
//
// The part opens at a `**Steps:**` / `**Steps**:` label or a `Steps` heading of any level and holds one
// numbered item per line (`1.` or `1)`); a more indented line joins the item above; it ends at the next
// bold label or heading. A label followed on its line by `1. ` holds the steps inline instead, in one
// paragraph (to the first blank line, fence, or list item at or left of the label's indent; the part ends
// at a heading or a labelled part, `**X:**`), split at ` <n>. ` with n running 2, 3, … in order and never
// inside a code span (CommonMark's: a run of k backticks closed by the next run of exactly k) (field 96); a
// numbered line left after that paragraph, and a step still holding an owner gate mid-text, are problems. An item ending `→ owner OK` or `-> owner OK` (any case,
// optional period) has an owner gate; one ending `(model: <m>, agent: <a>)` (either key, either order,
// before or after the gate, any case, each value one word) names its builder; the steps of one run must
// not name two models or two agents. Under the Acceptance label or heading, a list item that starts
// `Step N:` is step N's.
//
//   stepsOf(block) -> { steps: [{ n, text, gate: "owner" | null, accept: [text], model?, agent? }], problem }
//   runOf(steps, from) -> [from, g]   g: the first step from `from` with an owner gate, else the last
//   runMark(steps, stepRun, key) -> { value, from: "step N" } | null   the run's first step naming `key`
//   runText([a, g], total) -> "step 1 of 2" | "steps 2–3 of 3"

// A bold run that opens a line (after an optional bullet) is a label; a numbered item is not. In the
// inline form only a labelled part (`**X:**`, `**X**:`) is one: a wrapped line may start with bold text.
const LABEL = /^\s*(?:[-*+]\s+)?\*\*[^*\n]+\*\*/;
const LABELLED = /^\s*(?:[-*+]\s+)?\*\*[^*\n]+(?::\*\*|\*\*:)/;
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
const GATE = /\s*(?:→|->)\s*owner\s+ok\.?\s*$/i;
const GATE_ANY = /(?:→|->)\s*owner\s+ok\b/i;
const MARK = /\s*\(\s*((?:model|agent)\s*:[^()]*)\)\s*$/i;
const AGENTS = ["designer", "implementer"];
const TAG = /^step\s+(\d+)\s*:\s*/i;
const FENCE = /^\s*(```|~~~)/;

const indentOf = (line) => /^\s*/.exec(line)[0].length;

// The first part `name` opens: `{ head, body, indent }`, `head` the rest of a label's line ("" after a
// heading), `body` the lines after it, `indent` the opening line's; null when none opens. A bold run more indented than the list item above it
// is that item's text, not a label. With `inline` (a pattern), a head it matches opens the inline form.
function partOf(lines, name, inline = null) {
  let fenced = false;
  let body = null;
  let head = "";
  let inlined = false;
  let indent = 0;
  let item = -1; // the indent of the last list item in the part
  for (const line of lines) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = !fenced && HEADING.exec(line);
    const opens = !fenced && name.label.exec(line);
    if (body === null) {
      if (opens) head = line.slice(opens[0].length).trim();
      if (opens || (heading && name.heading.test(heading[1]))) body = [];
      inlined = Boolean(opens && inline?.test(head));
      indent = indentOf(line);
      continue;
    }
    const label = inlined
      ? LABELLED.test(line)
      : LABEL.test(line) && (item < 0 || indentOf(line) <= item);
    if (!fenced && (heading || label)) break;
    if (!fenced && LISTED.test(line)) item = indentOf(line);
    body.push(fenced || FENCE.test(line) ? "" : line);
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

// The code spans of `text` as CommonMark reads them, `[start, end)` each, in order: a run of k backticks
// opens a span only when a later run of exactly k closes it; an unmatched run is literal, and so is a
// backslash-escaped backtick outside a span (the rest of its run still counts). One pass over the runs.
function spansOf(text) {
  const runs = [];
  for (const m of text.matchAll(/`+/g)) {
    let slashes = 0;
    for (let i = m.index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
    runs.push({ at: m.index, len: m[0].length, escaped: slashes % 2 === 1 });
  }
  const byLength = new Map(); // a run length → the indexes of the runs that long, in order
  for (const [i, run] of runs.entries()) {
    if (!byLength.has(run.len)) byLength.set(run.len, []);
    byLength.get(run.len).push(i);
  }
  const seen = new Map(); // a run length → how far into its list the search has gone
  const spans = [];
  for (let i = 0; i < runs.length; i++) {
    const { at, len, escaped } = runs[i];
    const k = escaped ? len - 1 : len;
    const closers = byLength.get(k) ?? [];
    let p = seen.get(k) ?? 0;
    while (p < closers.length && closers[p] <= i) p++;
    seen.set(k, p);
    if (!k || p === closers.length) continue; // literal
    const close = runs[closers[p]];
    spans.push([escaped ? at + 1 : at, close.at + close.len]);
    i = closers[p]; // the runs inside the span are its text
  }
  return spans;
}

// The inline form: `head` (`1. …`) and the body up to its first blank line, or its first list item at or
// left of the label's `indent`, as one paragraph, split at ` 2. `, then ` 3. `, …, never inside a code
// span, so a number inside a step's text (`2.5 s`, `v1. x`, `` `make 2. x` ``) splits nothing.
// `{ items, left }`: `left` the first numbered line after the paragraph, else null.
function inlineItems(head, body, indent) {
  const end = body.findIndex(
    (line) => !line.trim() || (LISTED.test(line) && indentOf(line) <= indent),
  );
  const text = [head, ...body.slice(0, end < 0 ? body.length : end)]
    .map((line) => line.trim())
    .join(" ")
    .replace(/^1\.\s+/, "");
  const spans = spansOf(text);
  let s = 0; // the first span not wholly before the last match (matches only move right)
  const outside = (i) => {
    while (s < spans.length && spans[s][1] <= i) s++;
    return !(s < spans.length && spans[s][0] <= i);
  };
  const items = [];
  let from = 0;
  for (let n = 2; ; n++) {
    const re = new RegExp(`\\s${n}\\.\\s+`, "g");
    re.lastIndex = from;
    let m = re.exec(text);
    while (m && !outside(m.index)) m = re.exec(text);
    if (!m) break;
    items.push(text.slice(from, m.index));
    from = m.index + m[0].length;
  }
  items.push(text.slice(from));
  const left = end < 0 ? null : (body.slice(end).find((line) => NUMBERED.test(line)) ?? null);
  return {
    items: items.map((item, i) => ({ head: String(i + 1), text: item.trim() })),
    left: left?.trim() ?? null,
  };
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
  let marks = null;
  for (let pass = 0; pass < 2; pass++) {
    if (!gate && GATE.test(text)) {
      gate = "owner";
      text = text.replace(GATE, "");
    }
    const mark = !marks && MARK.exec(text);
    if (!mark) continue;
    marks = pairsOf(mark[1]);
    text = text.slice(0, mark.index);
  }
  const step = { n, text: text.trim(), gate, accept: [] };
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
  const lines = String(block ?? "").split(/\r?\n/);
  const part = partOf(lines, STEPS, INLINE);
  if (part === null) return { steps: [], problem: null };
  const { items, left } = INLINE.test(part.head)
    ? inlineItems(part.head, part.body, part.indent)
    : { items: itemsOf(part.body, NUMBERED), left: null };
  const parsed = items.map(({ head, text }) => stepOf(Number(head), text));
  const steps = parsed.map((p) => p.step);
  if (left)
    return {
      steps,
      problem: `a numbered line follows the inline steps' paragraph (${left}): keep the steps in one paragraph or put one per line`,
    };
  // The backstop: whatever the splitter missed, an inline step never swallows an owner gate silently.
  const swallowed = INLINE.test(part.head) && steps.find((s) => GATE_ANY.test(s.text));
  if (swallowed)
    return {
      steps,
      problem: `step ${swallowed.n} holds an owner gate mid-text: put each step on its own line`,
    };
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
