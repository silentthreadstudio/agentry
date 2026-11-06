// yaml-read — the YAML the store's frontmatter is read in: one block mapping whose values are scalars (plain,
// 'single' or "double" quoted, one line or folded over several; `|` and `>` block scalars with their chomping
// and indent indicators) or lists of scalars (block `- item` lines, or a flow `[a, b]` whose items are plain or
// quoted scalars), with `#` comments. Keys are plain (spaces allowed) or quoted. That is every file the store
// has written (the `yaml` package wrote them) and what a hand edit of one is likely to hold, including a nested
// BLOCK mapping under a key: it is found by its indentation, parsed strictly by this same reader and the result
// dropped, so a quote or bracket left open in it is a loud refusal (a key the schema knows that holds
// one fails the record check as an object, as before). Plain scalars resolve as in the YAML 1.2 core schema
// (null, true/false, integers, floats, `.inf`, `.nan`); everything else is a string.
//
// Refused, with the line (a readError names the file; the record is not loaded), never guessed at:
//   - a flow mapping `{…}`, on any key. Where one ends depends on quotes, comments and nesting that a scanner
//     got wrong three times, each time by silently swallowing the next field; a loud refusal of a rare hand
//     edit is cheaper than a quiet loss.
//   - a flow list with an item that is not a plain or quoted scalar (a list or a mapping in it).
//   - anchors, aliases and tags; a fully indented frontmatter; a `...` line; a byte-order mark.
// A document that is not a mapping at all reads as an empty one, so the record check says what is missing.
//
// parseMap(text) -> object        throws Error("line N: …") when the text is not YAML of that subset
const INT = /^[-+]?[0-9]+$/;
const OCT = /^0o[0-7]+$/;
const HEX = /^0x[0-9a-fA-F]+$/;
const FLOAT = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;
const SPECIAL = /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/;

const ESCAPES = {
  0: "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\x85",
  _: "\xa0",
  L: String.fromCodePoint(0x2028),
  P: String.fromCodePoint(0x2029),
};
const HEX_ESCAPES = { x: 2, u: 4, U: 8 };

// White space is the space and the tab: not the other characters JS trims (a no-break space is content).
const ltrim = (text) => text.replace(/^[ \t]+/, "");
const rtrim = (text) => text.replace(/[ \t]+$/, "");
const trim = (text) => rtrim(ltrim(text));
const blank = (line) => /^[ \t]*$/.test(line);
const skippable = (line) => blank(line) || ltrim(line).startsWith("#");
// Indentation is spaces: a tab after them is content.
const indentOf = (line) => line.length - line.replace(/^ +/, "").length;
const isItem = (line) => /^[ \t]*-(?:[ \t]|$)/.test(line);
// A comment starts at a `#` that follows white space.
const uncommented = (text) => rtrim(text.replace(/(^|[ \t])#[^\n]*$/, ""));

/** A plain scalar's value: null, a boolean, a number, or the text. */
function resolve(text) {
  if (/^(?:~|[Nn]ull|NULL)?$/.test(text)) return null;
  if (/^(?:[Tt]rue|TRUE)$/.test(text)) return true;
  if (/^(?:[Ff]alse|FALSE)$/.test(text)) return false;
  if (INT.test(text)) return Number.parseInt(text, 10);
  if (OCT.test(text)) return Number.parseInt(text.slice(2), 8);
  if (HEX.test(text)) return Number.parseInt(text, 16);
  if (SPECIAL.test(text))
    return text.slice(-3).toLowerCase() === "nan"
      ? Number.NaN
      : text[0] === "-"
        ? Number.NEGATIVE_INFINITY
        : Number.POSITIVE_INFINITY;
  if (FLOAT.test(text)) return Number.parseFloat(text);
  return text;
}

class Reader {
  constructor(lines, base = 0) {
    this.lines = lines;
    this.base = base; // the line number of lines[0], less one, in the whole frontmatter
  }

  fail(at, why) {
    throw new Error(`line ${at + 1 + this.base}: ${why}`);
  }

  // The first line at or after `from` that is not blank or a comment, or -1.
  meaningful(from) {
    for (let i = from; i < this.lines.length; i++) if (!skippable(this.lines[i])) return i;
    return -1;
  }

  /** The mapping at indent 0. */
  map() {
    const out = Object.create(null);
    let at = this.meaningful(0);
    while (at !== -1) {
      const line = this.lines[at];
      const m = this.keyLine(at, line);
      if (!m) {
        // a document that is not a mapping (a bare scalar, say) has no fields
        if (Object.keys(out).length === 0 && !/:(?:[ \t]|$)/.test(line)) return out;
        this.fail(at, line.startsWith(" ") ? "unexpected indentation" : "not a `key: value` line");
      }
      if (m.key in out) this.fail(at, `the key "${m.key}" is repeated`);
      const { value, next } = this.entry(at, m.rest);
      out[m.key] = value;
      at = this.meaningful(next);
    }
    return out;
  }

  // `key: rest` on a line, the key plain (spaces allowed) or quoted; null when the line is no such thing.
  keyLine(at, line) {
    const quoted = /^(["'])/.exec(line);
    if (quoted) {
      const { value, tail } = this.quoted(at, line, quoted[1]);
      const m = /^[ \t]*:(?:[ \t]+([^\n]*))?$/.exec(tail);
      return m ? { key: value, rest: m[1] ?? "" } : null;
    }
    const m = /^([^\s#&*!|>%@`[\]{},?-][^\n]*?)[ \t]*:(?:[ \t]+([^\n]*))?$/.exec(line);
    return m ? { key: m[1], rest: m[2] ?? "" } : null;
  }

  // The value of the key on line `at`, whose text after the colon is `rest`.
  entry(at, rest) {
    if (rest !== "" && !rest.startsWith("#")) return this.value(at, rest, 0);
    const nextAt = this.meaningful(at + 1);
    if (nextAt !== -1 && isItem(this.lines[nextAt])) return this.list(nextAt);
    if (nextAt === -1 || indentOf(this.lines[nextAt]) === 0) return { value: null, next: at + 1 };
    if (this.keyLine(nextAt, ltrim(this.lines[nextAt]))) {
      // a nested block mapping: read with the same strict reader, dedented, and the result dropped, so
      // whatever is malformed in it (an unclosed quote or bracket, a `{`) fails here with its line instead
      // of running on into the next top-level key. A field the schema knows then fails as an object.
      let j = nextAt;
      while (j < this.lines.length && (skippable(this.lines[j]) || indentOf(this.lines[j]) > 0))
        j++;
      const width = indentOf(this.lines[nextAt]);
      const inner = this.lines.slice(nextAt, j).map((line, k) => {
        if (!skippable(line) && indentOf(line) < width)
          this.fail(nextAt + k, "inconsistent indentation in a nested mapping");
        return line.slice(Math.min(width, indentOf(line)));
      });
      new Reader(inner, this.base + nextAt).map();
      return { value: {}, next: j };
    }
    return this.value(nextAt, ltrim(this.lines[nextAt]), 0);
  }

  // A block list whose first item is on line `first`; ends at the first line that is not one of its items.
  list(first) {
    const indent = indentOf(this.lines[first]);
    const items = [];
    let at = first;
    while (at !== -1 && at < this.lines.length) {
      const line = this.lines[at];
      if (!isItem(line) || indentOf(line) !== indent) break;
      const rest = ltrim(line.slice(indent + 1));
      let item;
      if (rest === "" || rest.startsWith("#")) {
        const nextAt = this.meaningful(at + 1);
        item =
          nextAt !== -1 && indentOf(this.lines[nextAt]) > indent
            ? this.value(nextAt, ltrim(this.lines[nextAt]), indent)
            : { value: null, next: at + 1 };
      } else item = this.value(at, rest, indent);
      items.push(item.value);
      at = this.meaningful(item.next);
    }
    return { value: items, next: at === -1 ? this.lines.length : at };
  }

  // The scalar or flow list that starts with `rest` on line `at`; `parent` is the indent of what holds it.
  value(at, rest, parent) {
    const c = rest[0];
    if (c === "|" || c === ">") return this.block(at, rest, parent);
    if (c === '"' || c === "'") {
      const { value, next, tail } = this.quoted(at, rest, c);
      if (trim(tail) !== "" && !/^[ \t]+#/.test(tail)) this.fail(at, "text after a quoted value");
      return { value, next };
    }
    if (c === "[") return this.flow(at, rest);
    if (c === "{")
      this.fail(at, "a flow mapping {…} is refused on any key (see the header of yaml-read.mjs)");
    if (c === "&" || c === "*" || c === "!")
      this.fail(at, "anchors, aliases and tags are outside the frontmatter subset");
    if (c === "@" || c === "`") this.fail(at, `a plain value cannot start with "${c}"`);
    if (/^(?:-|\?|:)(?:[ \t]|$)/.test(rest))
      this.fail(at, "a block collection is not allowed here");
    return this.plain(at, rest, parent);
  }

  // A plain scalar: its lines (trimmed) joined by a space, or by a newline per blank line between them.
  plain(at, rest, parent) {
    const chunks = [];
    let text = uncommented(rest);
    let blanks = 0;
    let i = at;
    for (;;) {
      if (/:(?:[ \t]|$)/.test(text))
        this.fail(i, "a nested mapping is outside the frontmatter subset");
      chunks.push(blanks ? "\n".repeat(blanks) : chunks.length ? " " : "", text);
      blanks = 0;
      let j = i + 1;
      while (j < this.lines.length && blank(this.lines[j])) j++;
      if (
        j >= this.lines.length ||
        indentOf(this.lines[j]) <= parent ||
        ltrim(this.lines[j]).startsWith("#")
      )
        break;
      blanks = j - i - 1;
      text = uncommented(trim(this.lines[j]));
      i = j;
    }
    return { value: resolve(chunks.join("")), next: i + 1 };
  }

  // A quoted scalar opening on line `at` with `rest`; `tail` is what follows the closing quote.
  quoted(at, rest, quote) {
    let out = "";
    let spaces = ""; // literal white space since the last character: dropped at a line break
    let text = rest.slice(1);
    let i = at;
    for (;;) {
      let broke = false;
      for (let k = 0; k < text.length; k++) {
        const ch = text[k];
        if (ch === quote) {
          if (quote === "'" && text[k + 1] === "'") {
            out += `${spaces}'`;
            spaces = "";
            k++;
            continue;
          }
          return { value: out + spaces, next: i + 1, tail: text.slice(k + 1) };
        }
        if (ch === " " || ch === "\t") {
          spaces += ch;
          continue;
        }
        out += spaces;
        spaces = "";
        if (quote === '"' && ch === "\\") {
          if (k + 1 === text.length) {
            broke = true; // an escaped line break: nothing joins the lines
            break;
          }
          const [char, used] = this.escape(i, text, k + 1);
          out += char;
          k += used;
        } else out += ch;
      }
      spaces = "";
      let j = i + 1;
      if (!broke) {
        while (j < this.lines.length && blank(this.lines[j])) j++;
        if (j >= this.lines.length) this.fail(at, "a quoted value is never closed");
        out += j - i - 1 ? "\n".repeat(j - i - 1) : " ";
      } else if (j >= this.lines.length) this.fail(at, "a quoted value is never closed");
      text = ltrim(this.lines[j]);
      i = j;
    }
  }

  // The character the escape at text[k] (just after the backslash) stands for, and the characters it uses.
  escape(at, text, k) {
    const ch = text[k];
    if (Object.hasOwn(HEX_ESCAPES, ch)) {
      const digits = text.slice(k + 1, k + 1 + HEX_ESCAPES[ch]);
      if (digits.length !== HEX_ESCAPES[ch] || !/^[0-9a-fA-F]+$/.test(digits))
        this.fail(at, `the escape \\${ch}${digits} is not valid`);
      return [String.fromCodePoint(Number.parseInt(digits, 16)), HEX_ESCAPES[ch] + 1];
    }
    if (!Object.hasOwn(ESCAPES, ch)) this.fail(at, `the escape \\${ch} is not valid`);
    return [ESCAPES[ch], 1];
  }

  // A `|` or `>` block scalar whose header is `rest` on line `at`.
  block(at, rest, parent) {
    const h = /^([|>])(?:([1-9])([+-]?)|([+-])([1-9]?))?[ \t]*(?:#[^\n]*)?$/.exec(rest);
    if (!h) this.fail(at, "a block scalar header is not valid");
    const folded = h[1] === ">";
    const chomp = h[3] || h[4] || "";
    const given = h[2] || h[5];
    let width = given ? parent + Number(given) : -1;
    const body = [];
    let i = at + 1;
    for (; i < this.lines.length; i++) {
      const line = this.lines[i];
      if (/^ *$/.test(line)) {
        body.push(width >= 0 && line.length > width ? line.slice(width) : "");
        continue;
      }
      const indent = indentOf(line);
      if (width < 0) width = indent <= parent ? Number.POSITIVE_INFINITY : indent;
      if (indent < width) break;
      body.push(line.slice(width));
    }
    // the blank lines at the end belong to the chomping, and the next key starts after them
    let trail = 0;
    while (body.length && body[body.length - 1] === "") {
      body.pop();
      trail++;
    }
    const text = folded ? foldLines(body) : body.join("\n");
    if (chomp === "-") return { value: text, next: i };
    if (chomp === "+")
      return {
        value: body.length ? `${text}\n${"\n".repeat(trail)}` : "\n".repeat(trail),
        next: i,
      };
    return { value: body.length ? `${text}\n` : "", next: i };
  }

  // A flow list `[a, 'b', "c"]` opening on line `at`, which may run over several lines.
  flow(at, rest) {
    let text = rest;
    for (let i = at; ; i++) {
      const items = this.flowItems(at, text);
      if (items) return { value: items.list, next: i + 1 };
      if (i + 1 >= this.lines.length) this.fail(at, "a flow list is never closed");
      text += ` ${trim(this.lines[i + 1])}`;
    }
  }

  // The items of the flow list in `text`, or null when it ends before the closing bracket.
  flowItems(at, text) {
    const list = [];
    let k = 1;
    for (;;) {
      while (text[k] === " " || text[k] === "\t") k++;
      if (k >= text.length) return null;
      if (text[k] === "]") break;
      const c = text[k];
      if (c === '"' || c === "'") {
        const chunk = text.slice(k);
        const { value, tail } = new Reader([chunk]).quoted(0, chunk, c);
        list.push(value);
        k = text.length - tail.length;
      } else {
        const end = text.slice(k).search(/[,\]]/);
        if (end === -1) return null;
        const item = trim(text.slice(k, k + end));
        if (item === "" || /[[{]|:(?:[ \t]|$)/.test(item))
          this.fail(at, "a flow list item must be a scalar");
        list.push(resolve(item));
        k += end;
      }
      while (text[k] === " " || text[k] === "\t") k++;
      if (text[k] === ",") k++;
      else if (text[k] !== "]")
        return text[k] === undefined ? null : this.fail(at, "a flow list item is not closed");
    }
    const tail = trim(text.slice(k + 1));
    if (tail !== "" && !tail.startsWith("#")) this.fail(at, "text after a flow list");
    return { list };
  }
}

// The lines of a folded `>` scalar: a line break between two ordinary lines is a space, each blank line
// between them a newline, and a more-indented line keeps its breaks.
function foldLines(body) {
  let out = "";
  let prev = null;
  let blanks = 0;
  for (const line of body) {
    if (line === "") {
      blanks++;
      continue;
    }
    if (prev === null) out += "\n".repeat(blanks);
    else if (/^[ \t]/.test(line) || /^[ \t]/.test(prev)) out += "\n".repeat(blanks + 1);
    else out += blanks ? "\n".repeat(blanks) : " ";
    out += line;
    prev = line;
    blanks = 0;
  }
  return out;
}

export function parseMap(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // a final newline ends the last line; it does not start another
  if (lines.at(-1) === "") lines.pop();
  return new Reader(lines).map();
}
