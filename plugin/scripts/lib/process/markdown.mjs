// markdown — the pure half of reading a board: headings, sections, tables, bold-lead lines and
// frontmatter, plus the cell parsers the process file's field types name (plan F13 §3.1).
//
// PURE: every function takes text and returns data. No I/O, no knowledge of the process file; `read.mjs`
// decides what a cell means. Line numbers are 1-based, as an editor shows them.

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const SEPARATOR_CELL = /^:?-+:?$/;
const LEAD = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?\*\*(.+?)\*\*(.*)$/;
// A run of 7+ decimal digits (`20261031`) is also valid hex, so it reads as a commit: in a `commits`
// or `evidence` cell it is checked against git and reported when missing. Known and kept: an
// abbreviated SHA can be all digits, and telling the two apart would need git, which this file lacks.
const SHA = /(?<![0-9A-Za-z])[0-9a-f]{7,40}(?![0-9A-Za-z])/g;
const LINK = /\[([^\]]*)\]\(\s*<?[^)\s>]+>?(?:\s+"[^"]*")?\s*\)/;
const DATE = /^(\d{4}-\d{2}-\d{2})/;

export function lines(text) {
  return text.split(/\r?\n/);
}

/** Every ATX heading outside fenced code: `{ level, text, line }`. */
export function headings(text) {
  const out = [];
  let fenced = false;
  lines(text).forEach((raw, i) => {
    if (FENCE.test(raw)) fenced = !fenced;
    if (fenced || FENCE.test(raw)) return;
    const m = HEADING.exec(raw);
    if (m) out.push({ level: m[1].length, text: m[2], line: i + 1 });
  });
  return out;
}

/** The first heading whose text is exactly `heading` (any level), and where its section ends: the line
 *  before the next heading of the same or a higher level. Body = lines `line + 1 … end`. Null if absent. */
export function section(text, heading) {
  const all = headings(text);
  const at = all.findIndex((h) => h.text === heading);
  if (at === -1) return null;
  const own = all[at];
  const next = all.slice(at + 1).find((h) => h.level <= own.level);
  return { ...own, end: next ? next.line - 1 : lines(text).length };
}

/** `**` and backticks stripped, trimmed: how every cell is read. */
export function plain(cell) {
  return String(cell ?? "")
    .replaceAll("**", "")
    .replaceAll("`", "")
    .trim();
}

/** One table row's cells; `\|` is a literal pipe. */
export function splitRow(raw) {
  const row = raw
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "");
  return row.split(/(?<!\\)\|/).map((cell) => cell.replaceAll("\\|", "|").trim());
}

const isRow = (raw) => raw?.trim().startsWith("|") ?? false;
const isSeparator = (raw) => isRow(raw) && splitRow(raw).every((c) => SEPARATOR_CELL.test(c));

/** Every pipe table outside fenced code: `{ heading, line, header, rows: [{ line, cells }] }`, where
 *  `heading` is the nearest heading above it, `header` the plain header names and `cells` maps each
 *  header name to the row's raw cell (missing cells read as ""). */
export function tables(text) {
  const all = lines(text);
  const out = [];
  let heading = null;
  let fenced = false;
  for (let i = 0; i < all.length; i++) {
    if (FENCE.test(all[i])) fenced = !fenced;
    if (fenced || FENCE.test(all[i])) continue;
    const h = HEADING.exec(all[i]);
    if (h) heading = h[2];
    if (!isRow(all[i]) || !isSeparator(all[i + 1])) continue;
    const header = splitRow(all[i]).map(plain);
    const rows = [];
    let j = i + 2;
    for (; j < all.length && isRow(all[j]); j++) {
      const cells = splitRow(all[j]);
      rows.push({
        line: j + 1,
        cells: Object.fromEntries(header.map((n, k) => [n, cells[k] ?? ""])),
      });
    }
    out.push({ heading, line: i + 1, header, rows });
    i = j - 1;
  }
  return out;
}

/** The first table inside a `section()` result, or null. */
export function tableIn(text, sec) {
  return tables(text).find((t) => t.line > sec.line && t.line <= sec.end) ?? null;
}

/** The ids a bold lead names: its tokens, split on space `/` `,` `+` `&` (`A/B` → A, B; `A merged` →
 *  A, merged). A rule asks "is this id one of them", so extra words are harmless. */
export function leadIds(lead) {
  return plain(lead)
    .split(/[\s/,+&]+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
}

/** Bold-lead lines (`- **ID** (sha): …` or `**ID** …`) in a section's body (or the whole text):
 *  `{ lead, ids, commits, line, text }`, where `commits` are the SHAs in the parentheses right after
 *  the lead and `text` is the whole line. */
export function boldLeads(text, sec) {
  const all = lines(text);
  const from = sec ? sec.line : 0;
  const to = sec ? sec.end : all.length;
  const out = [];
  for (let i = from; i < to; i++) {
    const m = LEAD.exec(all[i]);
    if (!m) continue;
    const paren = /^\s*\(([^)]*)\)/.exec(m[2]);
    out.push({
      lead: m[1].trim(),
      ids: leadIds(m[1]),
      commits: paren ? parseCommits(paren[1]) : [],
      line: i + 1,
      text: all[i],
    });
  }
  return out;
}

const unquote = (v) => v.trim().replace(/^(["'])(.*)\1$/, "$2");

/** Flat YAML frontmatter: `key: value` and inline lists `key: [a, b]`. `{ data, lines }` (the line of
 *  each key), or null when the text has none. Nested or block values are not read. */
export function frontmatter(text) {
  const all = lines(text);
  if (all[0]?.trim() !== "---") return null;
  const close = all.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (close === -1) return null;
  const data = {};
  const at = {};
  for (let i = 1; i < close; i++) {
    const kv = /^([\w.-]+):\s*(.*)$/.exec(all[i]);
    if (!kv) continue;
    const value = kv[2].trim();
    data[kv[1]] = /^\[.*\]$/.test(value)
      ? value.slice(1, -1).split(",").map(unquote).filter(Boolean)
      : unquote(value);
    at[kv[1]] = i + 1;
  }
  return { data, lines: at };
}

/** `filename:<pattern with {id}>` → a regex over a file's basename, group 1 = the id. */
export function filenameId(pattern) {
  const parts = pattern.split("{id}").map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&"));
  const glob = parts.map((p) => p.replaceAll("*", ".*").replaceAll("?", "."));
  return new RegExp(`^${glob.join("(.+?)")}$`);
}

// Cell parsers, one per field type (plan F13 §3.1). Each takes a plain cell.
const PARSE = {
  list: (v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  commits: (v) => v.match(SHA) ?? [],
  // The SHAs, then the remaining text as one note token when there is any.
  evidence: (v) => {
    const note = v.replace(SHA, " ").replace(/\s+/g, " ");
    const trimmed = note.replace(/^[\s,;:+…·.-]+|[\s,;:+…·-]+$/g, "");
    return trimmed ? [...PARSE.commits(v), trimmed] : PARSE.commits(v);
  },
  flag: (v, field) => (field.mark ? v.includes(field.mark) : v !== ""),
  // The link text (the target is the kind's own file, found by its glob); a cell without a link reads whole.
  link: (v) => (LINK.exec(v)?.[1] ?? v).trim() || null,
  date: (v) => DATE.exec(v)?.[1] ?? null,
};

/** `commits`: every `[0-9a-f]{7,40}` token of a cell. */
export const parseCommits = (cell) => PARSE.commits(plain(cell));

/** One cell (or frontmatter value) as its field reads it: plain, then `match`, then the `type`:
 *  `list`/`commits` → string[], `evidence` → the SHAs + one note token, `flag` → boolean, `link` →
 *  the first link's text (or the cell), `date` → a leading YYYY-MM-DD; null when match/date find
 *  nothing or the cell is empty. */
export function cellValue(raw, field) {
  const type = field.type ?? "text";
  if (Array.isArray(raw) && type === "list") return raw.map(plain).filter(Boolean);
  let value = plain(Array.isArray(raw) ? raw.join(", ") : raw);
  if (field.match) value = applyMatch(value, field.match);
  if (value === null) return null;
  if (PARSE[type]) return PARSE[type](value, field);
  return field.case === "upper" ? value.toUpperCase() : value;
}

/** A `match` regex: group 1 when the regex has one, else the whole match; null when it doesn't match
 *  (or the regex is invalid, which the spec check reports). */
export function applyMatch(value, pattern) {
  let re;
  try {
    re = new RegExp(pattern);
  } catch {
    return null;
  }
  const m = re.exec(value);
  return m ? (m[1] ?? m[0]) : null;
}
