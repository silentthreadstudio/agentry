// render — the board as terminal text (the pinned F13 checker design). Line 1 is always the verdict
// with the exit code, because Claude Code folds long tool output and shows the top. One line per
// thing, ≤ WIDTH columns, no emoji. Color only on a TTY and only on glyphs; words keep the default
// color (bold and dim mark structure). PURE: data in, text out.
import { titleOf } from "./status.mjs";

export const WIDTH = 80;
const LABEL = 11;
const BAR = 12;
const GLYPH = { done: "■", verify: "◆", active: "●", planned: "□", dropped: "×" };

/** Styling that is a no-op off a TTY. */
export function style(tty) {
  const sgr = (code) => (text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
  return { red: sgr(31), green: sgr(32), cyan: sgr(36), bold: sgr(1), dim: sgr(2) };
}

/** Cut `text` to `n` columns with an ellipsis. */
export const fit = (text, n) => {
  const chars = [...String(text)];
  return chars.length <= n ? chars.join("") : `${chars.slice(0, Math.max(0, n - 1)).join("")}…`;
};
const pad = (text, n) => fit(text, n).padEnd(n);
const widest = (xs) => Math.max(0, ...xs.map((x) => [...x].length));

/** `text` as lines of at most `n` columns, broken between words; only a word wider than `n` is split. */
export function wrapText(text, n) {
  const out = [];
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    let rest = [...word];
    const last = out.at(-1);
    if (last !== undefined && [...last].length + 1 + rest.length <= n) {
      out[out.length - 1] = `${last} ${word}`;
      continue;
    }
    for (; rest.length > n; rest = rest.slice(n)) out.push(rest.slice(0, n).join(""));
    out.push(rest.join(""));
  }
  return out.length ? out : [""];
}

/** Rows of cells as aligned columns (two spaces apart), each line cut to `width`. */
export function columns(rows, width = WIDTH) {
  const w = rows[0]?.map((_, i) => widest(rows.map((r) => String(r[i] ?? "")))) ?? [];
  return rows.map((r) =>
    fit(
      r
        .map((c, i) => (i < r.length - 1 ? String(c ?? "").padEnd(w[i]) : c))
        .join("  ")
        .trimEnd(),
      width,
    ),
  );
}

const exitOf = (report) => (report.ok ? 0 : 1);

/** Line 1: `✗ Name  3 problems · 12 rules · 34 tasks · exit 1` or `✓ Name  OK · … · exit 0`. */
export function verdict(report, { work, s }) {
  const n = report.findings.length;
  const glyph = report.ok ? s.green("✓") : s.red("✗");
  const head = report.ok ? "OK" : `${n} problem${n === 1 ? "" : "s"}`;
  const tasks = `${report.items[work] ?? 0} ${work.replace(/([^aeiou])y$/, "$1ie")}s`;
  return `${glyph} ${s.bold(report.name)}  ${head} · ${report.rules} rules · ${tasks} · ${s.bold(`exit ${exitOf(report)}`)}`;
}

/** One finding per entry: `✗ <rule> <id> <message> <file:line>`, the location in its own column on
 *  the first line; a message too long for its column goes on, whole words, on indented lines below. */
export function findingLines(findings, s) {
  const rows = findings.map((f) => ({
    rule: f.label ? `${f.label} ${f.rule}` : f.rule,
    id: f.id ?? "—",
    message: f.message,
    at: f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "",
  }));
  const r = widest(rows.map((x) => x.rule));
  const i = widest(rows.map((x) => x.id));
  const at = widest(rows.map((x) => x.at));
  const room = Math.max(20, WIDTH - (2 + r + 2 + i + 2) - (at ? at + 2 : 0));
  const m = Math.min(room, widest(rows.map((x) => x.message)));
  const indent = " ".repeat(2 + r + 2 + i + 2);
  return rows.flatMap((x) => {
    const [first, ...rest] = wrapText(x.message, m);
    const tail = x.at ? `  ${s.dim(x.at)}` : "";
    const head = `${s.red("✗")} ${pad(x.rule, r)}  ${s.bold(pad(x.id, i))}  ${pad(first, m)}${tail}`;
    return [head.trimEnd(), ...rest.map((l) => indent + l)];
  });
}

/** How many of the process file's rule entries found nothing. */
const holding = (spec, findings) =>
  spec.rules.filter((e) => !findings.some((f) => f.rule === e.rule && f.label === e.label)).length;

function hint(spec, report, s) {
  return s.dim(`${holding(spec, report.findings)} rules hold · --why <id>`);
}

/** `check`: the verdict, then the findings and a hint; a clean board is the verdict alone. */
export function renderCheck({ spec, report, work, tty = false }) {
  const s = style(tty);
  const head = verdict(report, { work, s });
  if (report.ok) return head;
  return [head, "", ...findingLines(report.findings, s), "", hint(spec, report, s)].join("\n");
}

function bar(tally, s) {
  const seq = Object.keys(GLYPH).flatMap((k) => Array(tally[k] ?? 0).fill(k));
  const shown =
    seq.length <= BAR
      ? seq
      : Array.from({ length: BAR }, (_, i) => seq[Math.floor((i * seq.length) / BAR)]);
  const done = shown.filter((k) => k === "done").length;
  const rest = shown
    .slice(done)
    .map((k) => GLYPH[k])
    .join("");
  return { text: s.green(GLYPH.done.repeat(done)) + rest, width: shown.length };
}

const row = (label, text, s) => `${s.bold(label.padEnd(LABEL))}${text}`;

function nowLines(items, s) {
  if (!items.length) return [row("Now", "—", s)];
  const id = widest(items.map((x) => x.id));
  const name = Math.min(26, widest(items.map((x) => x.name ?? "")));
  const st = widest(items.map((x) => x.status ?? ""));
  return items.map((x, n) => {
    const b = bar(x.tally, s);
    const cells = `${pad(x.id, id)}  ${pad(x.name ?? "", name)}  ${pad(x.status ?? "", st)}  `;
    return row(
      n ? "" : "Now",
      `${cells}${b.text}${" ".repeat(BAR - b.width)}  ${x.done}/${x.total}`,
      s,
    );
  });
}

const line = (text) => fit(text, WIDTH - LABEL) || "—";

function blockLines(view, s) {
  const verify = new Set(view.onYou.map((x) => x.id));
  const groups = new Map();
  for (const x of view.inFlight) groups.set(x.status, [...(groups.get(x.status) ?? []), x]);
  const flight = [...groups]
    .sort(([, a], [, b]) => verify.has(a[0].id) - verify.has(b[0].id))
    .map(([status, xs]) => `${xs.map((x) => x.id).join(" ")} ${status}`)
    .join(" · ");
  // Glyph-led entries, as many as fit, then "+N".
  const onYou = [];
  let used = 0;
  view.onYou.forEach((x, n) => {
    const work = view.inFlight.some((f) => f.id === x.id);
    const text = work ? x.id : `${x.id} ${x.status}`;
    const more = view.onYou.length - n - 1;
    const room = WIDTH - LABEL - used - (more ? 5 : 0);
    if (used < 0 || [...text].length + 2 > room) {
      if (used >= 0) onYou.push(`+${view.onYou.length - n}`);
      used = -1;
      return;
    }
    onYou.push(`${s.cyan(work ? "◆" : "?")} ${text}`);
    used += [...text].length + 4;
  });
  const behind = new Map();
  for (const b of view.blocked) behind.set(b.by[0], (behind.get(b.by[0]) ?? 0) + 1);
  const blocked = [...behind]
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `${n} behind ${id}`)
    .join(", ");
  const ahead = [
    ...view.ahead.map((x) => `${x.id} ${x.done}/${x.total}`),
    ...(view.parked ? [`${view.parked} parked`] : []),
  ].join(" · ");
  return [
    row("In flight", line(flight), s),
    row("On you", onYou.length ? onYou.join("  ") : "—", s),
    row(
      "Blocked",
      line(view.blocked.length ? `${view.blocked.length} waiting: ${blocked}` : ""),
      s,
    ),
    row("Ahead", ahead ? s.dim(line(ahead)) : "—", s),
  ];
}

/** `status`: verdict, where it read from, Now / In flight / On you / Blocked / Ahead, the findings and
 *  the legend. A clean board is the verdict and the Now block only. */
export function renderStatus({ spec, report, view, work, subtitle, tty = false }) {
  const s = style(tty);
  const head = verdict(report, { work, s });
  if (report.ok) return [head, "", ...nowLines(view.now, s)].join("\n");
  const legend = `■ done  ◆ verify  ● doing  □ todo  × cut     ${holding(spec, report.findings)} rules hold · --why <id>`;
  return [
    head,
    ...(subtitle ? [s.dim(fit(subtitle, WIDTH))] : []),
    "",
    ...nowLines(view.now, s),
    ...blockLines(view, s),
    "",
    ...findingLines(report.findings, s),
    "",
    s.dim(fit(legend, WIDTH)),
  ].join("\n");
}

/** `--why <id>` as a CLI result: exit 2 when no item has that id, else 1 when it has findings. */
export function why({ spec, model, report, id, tty }) {
  if (!model.index[id]) return { exit: 2, out: `no item "${id}" on the board` };
  const exit = report.findings.some((f) => f.id === id) ? 1 : 0;
  return { exit, out: renderWhy({ spec, model, report, id, tty }) };
}

/** `--why <id>`: one item, where it sits, and each rule that applies to its kind, failing or holding. */
export function renderWhy({ spec, model, report, id, tty = false }) {
  const s = style(tty);
  return (model.index[id] ?? [])
    .map((item) => {
      const mine = report.findings.filter((f) => f.id === id && f.kind === item.kind);
      const parent = item.parent
        ? model.index[item.parent]?.find((p) => p.kind !== item.kind)
        : undefined;
      const where = [
        `${item.file}:${item.line}`,
        item.kind,
        ...(parent ? [`${parent.kind} ${parent.id} (${parent.status ?? parent.phase})`] : []),
        ...(item.status || item.phase ? [`status ${item.status ?? item.phase}`] : []),
      ].join(" · ");
      const applies = spec.rules.filter((e) => !e.kind || e.kind === item.kind);
      const failing = applies.filter((e) => mine.some((f) => f.rule === e.rule));
      const holds = [...new Set(applies.filter((e) => !failing.includes(e)).map((e) => e.rule))];
      const r = widest(mine.map((x) => x.rule));
      const fail = mine.flatMap((f) => {
        const [first, ...rest] = wrapText(f.message, Math.max(20, WIDTH - r - 4));
        const more = rest.map((l) => `${" ".repeat(r + 4)}${l}`);
        return [`${s.red("✗")} ${f.rule.padEnd(r)}  ${first}`, ...more];
      });
      return [
        `${s.bold(item.id)}  ${fit(titleOf(spec, item) ?? "", WIDTH - item.id.length - 2)}`,
        s.dim(fit(`     ${where}`, WIDTH)),
        "",
        ...fail,
        ...(holds.length
          ? wrap(holds, WIDTH - 2).map((l, n) => `${n ? " " : s.green("✓")} ${l}`)
          : []),
      ].join("\n");
    })
    .join("\n\n");
}

// Words joined with " · ", wrapped to `width`.
function wrap(words, width) {
  const out = [];
  for (const w of words) {
    const last = out.at(-1);
    if (last !== undefined && last.length + 3 + w.length <= width)
      out[out.length - 1] = `${last} · ${w}`;
    else out.push(w);
  }
  return out;
}
