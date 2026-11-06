// yaml-write — the YAML the store's frontmatter is written in, for the subset it uses: one flat mapping
// whose values are strings, numbers, booleans, null, or lists of strings. It writes what the `yaml`
// package's `stringify` writes for the same record (the store's old writer): the same quoting (plain
// where that reads back as the same string, else double quotes, or single when the text holds `"` and no
// `'`), the same block scalars for text with line breaks, the same folding at 80 columns, `[]` for an
// empty list and lists indented two spaces under their key. A file rewritten here is byte-identical to
// the one the old writer left. Pure.
//
// stringifyMap(record) -> string        ends with a newline; keys with an undefined value are left out
import { fold } from "./yaml-fold.mjs";

// What a plain scalar must not read back as (YAML 1.2 core schema): null, booleans, numbers.
const NOT_A_STRING = [
  /^(?:~|[Nn]ull|NULL)?$/,
  /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
  /^[-+]?[0-9]+$/,
  /^0o[0-7]+$/,
  /^0x[0-9a-fA-F]+$/,
  /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
  /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
  /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
];
// Text a plain scalar can't hold: an indicator first, `: ` or ` #` inside, a trailing space or colon.
const NOT_PLAIN =
  /^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters a plain scalar cannot hold
const NEEDS_DOUBLE = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u;
const DOUBLE_MULTILINE_MIN = 40;
const WIDTH = 80;

// A line starting with `%`, `---` or `...` would read as a document marker.
const hasDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);

function lineLengthOverLimit(str, limit) {
  if (str.length <= limit) return false;
  for (let i = 0, start = 0; i < str.length; ++i) {
    if (str[i] === "\n") {
      if (i - start > limit) return true;
      start = i + 1;
      if (str.length - start <= limit) return false;
    }
  }
  return true;
}

// `ctx` = { indent, indentAtStart }: the indent of the value's continuation lines, and the column its
// first line starts at (undefined for a list item, whose line the folding then doesn't count).
function doubleQuoted(value, ctx) {
  const json = JSON.stringify(value);
  const indent = ctx.indent || (hasDocumentMarker(value) ? "  " : "");
  let str = "";
  let start = 0;
  for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
    if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
      // a space before a newline is escaped so folding can't eat it
      str += `${json.slice(start, i)}\\ `;
      i += 1;
      start = i;
      ch = "\\";
    }
    if (ch === "\\")
      switch (json[i + 1]) {
        case "u": {
          str += json.slice(start, i);
          const code = json.substr(i + 2, 4);
          const named = {
            "0000": "\\0",
            "0007": "\\a",
            "000b": "\\v",
            "001b": "\\e",
            "0085": "\\N",
            "00a0": "\\_",
            2028: "\\L",
            2029: "\\P",
          }[code];
          if (named) str += named;
          else if (code.substr(0, 2) === "00") str += `\\x${code.substr(2)}`;
          else str += json.substr(i, 6);
          i += 5;
          start = i + 1;
          break;
        }
        case "n":
          if (json[i + 2] === '"' || json.length < DOUBLE_MULTILINE_MIN) {
            i += 1;
          } else {
            // folding eats the first newline
            str += `${json.slice(start, i)}\n\n`;
            while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
              str += "\n";
              i += 2;
            }
            str += indent;
            // a space after a newline is escaped so folding can't eat it
            if (json[i + 2] === " ") str += "\\";
            i += 1;
            start = i + 1;
          }
          break;
        default:
          i += 1;
      }
  }
  str = start ? str + json.slice(start) : json;
  return fold(str, indent, "quoted", { indentAtStart: ctx.indentAtStart });
}

function singleQuoted(value, ctx) {
  // a single-quoted string can't have white space around a line break
  if (/[ \t]\n|\n[ \t]/.test(value)) return doubleQuoted(value, ctx);
  const indent = ctx.indent || (hasDocumentMarker(value) ? "  " : "");
  const res = `'${value.replace(/'/g, "''").replace(/\n+/g, `$&\n${indent}`)}'`;
  return fold(res, indent, "flow", { indentAtStart: ctx.indentAtStart });
}

function quoted(value, ctx) {
  const hasDouble = value.includes('"');
  const hasSingle = value.includes("'");
  return hasDouble && !hasSingle ? singleQuoted(value, ctx) : doubleQuoted(value, ctx);
}

// Text with line breaks: a literal `|` scalar, or a folded `>` one when a line is longer than fits.
function block(text, ctx) {
  // a block can't end in white space unless its last line is non-empty
  if (/\n[\t ]+$/.test(text)) return quoted(text, ctx);
  const indent = ctx.indent || (hasDocumentMarker(text) ? "  " : "");
  const literal = !lineLengthOverLimit(text, WIDTH - indent.length);
  let value = text;

  // chomping, from the white space at the end
  let endStart;
  for (endStart = value.length; endStart > 0; --endStart) {
    const ch = value[endStart - 1];
    if (ch !== "\n" && ch !== "\t" && ch !== " ") break;
  }
  let end = value.substring(endStart);
  const endNl = end.indexOf("\n");
  let chomp;
  if (endNl === -1) chomp = "-";
  else if (value === end || endNl !== end.length - 1) chomp = "+";
  else chomp = "";
  if (end) {
    value = value.slice(0, -end.length);
    if (end[end.length - 1] === "\n") end = end.slice(0, -1);
    end = end.replace(/(^|(?<!\n))\n+(?!\n|$)/g, `$&${indent}`);
  }

  // the indent indicator, from the white space at the start
  let startWithSpace = false;
  let startEnd;
  let startNl = -1;
  for (startEnd = 0; startEnd < value.length; ++startEnd) {
    const ch = value[startEnd];
    if (ch === " ") startWithSpace = true;
    else if (ch === "\n") startNl = startEnd;
    else break;
  }
  let start = value.substring(0, startNl < startEnd ? startNl + 1 : startEnd);
  if (start) {
    value = value.substring(start.length);
    start = start.replace(/\n+/g, `$&${indent}`);
  }
  const header = (startWithSpace ? (indent ? "2" : "1") : "") + chomp;

  if (!literal) {
    const folded = value
      .replace(/\n+/g, "\n$&")
      .replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2") // more-indented lines aren't folded
      .replace(/\n+/g, `$&${indent}`);
    let overflowed = false;
    const body = fold(`${start}${folded}${end}`, indent, "block", {
      indentAtStart: indent.length,
      onOverflow: () => {
        overflowed = true;
      },
    });
    if (!overflowed) return `>${header}\n${indent}${body}`;
  }
  value = value.replace(/\n+/g, `$&${indent}`);
  return `|${header}\n${indent}${start}${value}${end}`;
}

function plain(value, ctx) {
  if (NOT_PLAIN.test(value)) return value.includes("\n") ? block(value, ctx) : quoted(value, ctx);
  if (value.includes("\n")) return block(value, ctx);
  if (NOT_A_STRING.some((re) => re.test(value))) return quoted(value, ctx);
  return fold(value, ctx.indent, "flow", { indentAtStart: ctx.indentAtStart });
}

const string = (value, ctx) =>
  NEEDS_DOUBLE.test(value) ? doubleQuoted(value, ctx) : plain(value, ctx);

function scalar(value, ctx) {
  if (typeof value === "string") return string(value, ctx);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return Number.isNaN(value) ? ".nan" : value < 0 ? "-.inf" : ".inf";
    return Object.is(value, -0) ? "-0" : JSON.stringify(value);
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  throw new Error(`cannot write a ${typeof value} as frontmatter`);
}

const KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** `record` as a YAML block mapping, as the `yaml` package writes it. */
export function stringifyMap(record) {
  const lines = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    if (!KEY.test(key)) throw new Error(`cannot write the key "${key}" as frontmatter`);
    if (Array.isArray(value)) {
      if (value.length === 0) lines.push(`${key}: []`);
      else {
        lines.push(`${key}:`);
        for (const item of value) lines.push(`  - ${scalar(item, { indent: "    " })}`);
      }
    } else lines.push(`${key}: ${scalar(value, { indent: "  ", indentAtStart: key.length + 2 })}`);
  }
  return lines.length ? `${lines.join("\n")}\n` : "{}\n";
}
