// owns — the paths a contract's "owns" clause names, read from the prose of its block: the one parser
// every lane step that asks "is this file the lane's?" uses (the open, the guard, the carry, adopt).
//
//   ownedFiles            the paths the clause names (backticked, brace globs expanded, negations,
//                         `:NN`-cited paths, "stays" asides, code fences and paths that leave the repository
//                         left out), in order; given the tree, a dotted symbol is not a path unless a file
//                         matches
//   outsideOwns           the paths of that clause that leave the repository (a `..` segment): the ones
//                         `ownedFiles` dropped for it (a leading-`/` span is dropped silently, never owned)
//   ownsTestsWithoutFile  does the clause say "tests" while no owned path is a test file?
//   withNew               those paths, each marked `new` when the tree has no such file; a path missing at the
//                         root is looked up among the tree's tracked files as a suffix (`merge/gating.mjs`, a
//                         bare name, a glob's folder): one hit is that path, several are all listed
//                         `ambiguous`; a new file under a first folder found only deeper (`pt/x.py` →
//                         `tools/pt/x.py`) goes there
//
// Reads the tree's tracked files (`git ls-files`); writes nothing. Node built-ins only.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { unfenced } from "../process/markdown.mjs";

// Where a contract's own-list ends: the next labelled part of the contract.
const OWNS = /\bowns\b\s*[:*]*/i;
// A bold owns label (`**Owns:**`, `**Owns**:`) starts the clause wherever the word "owns" shows up earlier in
// prose; the prose form is read only when the block has no such label.
const BOLD_OWNS = /\*\*\s*owns\s*(?::\s*\*\*|\*\*\s*:?)/i;
// A bold step label (`**step 1:**`, `**Step 2 (mock):**`) carries the owns clause on, like an owns label.
const STEP_LABEL = /\*\*\s*step\s*\d/i;
// Where an exclusion opens in the clause: "Not:", "Not ", "Excludes:" or "Except:" at the clause start or
// after a `;`, `.` or `(`. It runs to the end of the clause.
const EXCLUSION = /(?:^|[;.(])\s*(?:not[:\s]|excludes\s*:|except\s*:)/i;
const NEXT_PART =
  /\b(exposes|interface|excludes|deps|accept(?:ance)?|out of scope|goal|rules)\b\s*[:*]/i;
// The owns clause also ends at a ` · ` and at a bold label, unless the label is itself an owns label
// ("**step 2 owns:**"), which the clause carries on through.
const SEPARATOR = /\s·\s/;
// A label opens a line or follows a full stop; bold in the middle of a sentence ("**in place**") is emphasis.
const BOLD_LABEL = /(?:^|\n|[.;]\s)[ \t]*(?:[-*]\s+)?\*\*[^*\n]+\*\*/g;
// What follows a path that is cited, not owned: `x.gd` (`:48`), `x.gd`:48.
const CITED = /^\s*\(?\s*`?:\d/;
// An aside that cites lines (`:48`) or says what stays is context.
const CONTEXT_ASIDE = /:\d|\bstays\b/i;
// A code span may cross one line break (never a blank line): the break and its indentation are dropped.
const TICKED = /`([^`\n]+(?:[ \t]*\n[ \t]*[^`\s][^`\n]*)?)`/g;
const MAX_BRACED = 64;
// A sentence of the owns clause that says its paths are out of scope ("a fix that needs `x` stops and
// reports 'needs context' first"): the paths it points at are not owned.
const OUT_OF_SCOPE =
  /\bstops\b|\bneeds context\b|\bask first\b|after the owner['’]s OK|\bnot owned\b|\bnever\b|\bdon['’]?t touch\b|\bdo not touch\b/i;
// Where a sentence ends: after a `.`, `!` or `?`, a space and an upper-case letter or a quote, or the end of
// a line when the next line is not indented, not a list item and not a bold label (those go on, or end the clause on their own).
const SENTENCE_BREAK = /^(?:[ \t]+["'“‘A-Z]|[ \t]*\r?\n(?=\S)(?![-*+]\s|\*\*))/;
// A list-form clause opens with a line break and a bullet; an owns label in the next sentence carries the
// clause on, like a step label.
const LIST_CLAUSE = /^[ \t]*\r?\n\s*[-*+]\s/;
const OWNS_AGAIN = /^\s*owns\b/i;
const ABBREVIATION = /\b(?:e\.g|i\.e)\.$/i;

// A code span is an owned path when it is made of path characters and either ends in a known file
// extension or names a folder or glob (has a `/`) whose last part is not a bare number (`KEY_1/2` is a
// string key). `Type.method()` and `a.b.c` are symbols: no known extension, or (`a.b.c`) a bare name with
// more dots than an extension and no tracked file of that name (a leading dot is not one). A bare name
// without a dot is a path only when it is a well-known extensionless file; a bare dotfile (`.srchash`),
// only when a tracked file has that name.
const PATH_CHARS = /^[\w@.~*+-]+(\/[\w@.~*+-]+)*\/?$/;
const EXTENSIONS = new Set(
  (
    "ts tsx js jsx mjs cjs json jsonc md mdx txt css scss sass less html htm vue svelte astro " +
    "py rb go rs java kt swift c h cpp hpp cs php lua gd tscn tres res import godot cfg ini toml " +
    "yaml yml xml svg png jpg jpeg gif webp wav ogg mp3 glsl shader gdshader sql sh csv lock"
  ).split(" "),
);
const PLAIN_NAMES = new Set(["Makefile", "Dockerfile", "LICENSE"]);
// The part before the extension that makes `a.test.mjs` a file name, not a symbol path.
const COMPOUND = new Set(["test", "spec", "d", "min", "config", "stories"]);
// What a span may carry after the path: `:12`, `:12-30`, `#L12`.
const LOCATION = /(?::\d+(?:[-–—]\d+)?|#L\d+(?:-L?\d+)?)+$/;
// Words before a span that say its file is NOT owned ("no line in", "but not", "never", …).
const NEGATION =
  /\b(no|not|never|neither|none|nothing|without|except|excluding|exclude|forbidden|don'?t|doesn'?t|out of scope)\b/i;
// What may sit between two spans of one list: a comma, "and", "or".
const LIST_GAP = /^\s*(and|or|&)?\s*$/i;
// A bare extension span (`.tscn`) right after a path, joined by `+`, `and` or a comma: the path's sibling.
const SIBLING_GAP = /^\s*(?:\+|,|and|,\s*and)\s*$/i;
const BARE_EXTENSION = /^\.[A-Za-z0-9]+$/;
// A test file: under a `test`/`tests` folder, or a name with `test` or `_spec` in it.
const TEST_FILE = /(?:^|\/)tests?\/|[^/]*(?:test|_spec)[^/]*$/i;
const TESTS_WORD = /\btests?\b/i;

// Is a tracked file named `name` (as a whole path tail)?
const hasFile = (tracked, name) =>
  tracked().some((file) => file === name || file.endsWith(`/${name}`));

function pathOf(span, tracked) {
  const path = span.trim().replace(LOCATION, "");
  if (!PATH_CHARS.test(path)) return null;
  if (path.includes("/"))
    return /^\d+$/.test(path.replace(/\/$/, "").split("/").at(-1)) ? null : path;
  const dot = path.lastIndexOf(".");
  if (dot < 0) return PLAIN_NAMES.has(path) ? path : null;
  if (dot === 0 && !path.slice(1).includes(".")) return hasFile(tracked, path) ? path : null;
  const parts = path.replace(/^\./, "").split(".");
  if (!EXTENSIONS.has(parts.at(-1).toLowerCase())) return null;
  return parts.length === 2 || COMPOUND.has(parts.at(-2).toLowerCase()) || hasFile(tracked, path)
    ? path
    : null;
}

// `a/{b,c}.md` as `a/b.md` and `a/c.md`: each group of alternatives, left to right. A span with a space
// in it is not a path list.
function braced(span) {
  const group = /\{([^{}]*)\}/.exec(span);
  if (!group || /\s/.test(span)) return [span];
  const [whole, alts] = group;
  return alts
    .split(",")
    .flatMap((alt) =>
      braced(span.slice(0, group.index) + alt + span.slice(group.index + whole.length)),
    )
    .slice(0, MAX_BRACED);
}

// Where the sentences of `part` end: each sentence break outside code spans and parentheses, not after
// `e.g.` or `i.e.`.
function sentenceEnds(part) {
  const masked = part.replace(TICKED, (span) => " ".repeat(span.length));
  const ends = [];
  let depth = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (
      depth === 0 &&
      ".!?".includes(ch) &&
      !ABBREVIATION.test(masked.slice(0, i + 1)) &&
      SENTENCE_BREAK.test(part.slice(i + 1)) &&
      !OWNS_AGAIN.test(part.slice(i + 1))
    )
      ends.push(i + 1);
  }
  return ends;
}

// Where the clause's first sentence ends, or the clause's length. A clause set out as a list (the label,
// then bullets) runs over its items, whatever they end with.
// A step label further on carries the clause on: every step's paths stay owned.
const sentenceEnd = (part) =>
  LIST_CLAUSE.test(part)
    ? part.length
    : (sentenceEnds(part).find((end) => !STEP_AHEAD.test(part.slice(end))) ?? part.length);

// The masked clause with every parenthesised aside blanked (same length, so indexes still line up).
function outsideAsides(masked) {
  let depth = 0;
  let out = "";
  for (const ch of masked) {
    if (ch === "(") depth += 1;
    out += depth > 0 ? " " : ch;
    if (ch === ")" && depth > 0) depth -= 1;
  }
  return out;
}

// Where a part of a sentence ends and the next begins: a `;`, a "but" or a dash.
const STEP_AHEAD = /\*\*\s*step\s*\d|\bstep\s*\d+\s*\(?\s*owns\b/i;
const STEP_AT = new RegExp(STEP_AHEAD.source, "gi");
const LIST_ITEM = /\n[ \t]*[-*+]\s/g;
const SENTENCE_PART = /;|\bbut\b|\s[—–]\s/g;

// Does the part of the sentence that holds `at` say its paths are out of scope? Its trigger comes before
// `at`, or, for a path in an aside, right after the aside ("(`x`, `y`) stops …": no comma or code span
// between). `outer` is the clause with its asides blanked and `raw` the same with its code spans kept.
function saysOut({ outer, raw }, cuts, at, inAside) {
  const start = cuts.findLast((cut) => cut <= at) ?? 0;
  const end = cuts.find((cut) => cut > at) ?? outer.length;
  const trigger = OUT_OF_SCOPE.exec(outer.slice(start, end));
  if (!trigger) return false;
  const found = start + trigger.index;
  return found < at || (inAside && !/[,`]/.test(raw.slice(at, found)));
}

// Where the owns clause ends in `part` (the text after the label): the first of the next labelled part,
// the next ` · `, the next bold label that is not an owns or step label, and the end of the sentence.
function clauseEnd(part) {
  const bold = [...part.matchAll(BOLD_LABEL)].find(
    (m) => !OWNS.test(m[0]) && !STEP_LABEL.test(m[0]),
  );
  return Math.min(
    NEXT_PART.exec(part)?.index ?? part.length,
    SEPARATOR.exec(part)?.index ?? part.length,
    bold?.index ?? part.length,
    sentenceEnd(part),
  );
}

// The parenthesised aside that holds `at`, or "". `masked` is the clause with its code spans blanked,
// so only the prose's own parentheses count; an aside does not run past a blank line or a list item.
// With `toAt` it is the aside's text up to `at`.
function asideAt(part, masked, at, toAt = false) {
  const para = masked
    .slice(0, at)
    .split(/\n\s*\n|\n\s*[-*]\s/)
    .at(-1);
  const open = [];
  for (let i = at - para.length; i < at; i += 1) {
    if (masked[i] === "(") open.push(i);
    else if (masked[i] === ")") open.pop();
  }
  if (!open.length) return "";
  const close = masked.indexOf(")", at);
  return part.slice(open[0], toAt ? at : close < 0 ? part.length : close);
}

// Does the path leave the repository: a `..` segment, even one that would come back in?
const leaves = (path) => path.split("/").includes("..");

/** The paths the block's "owns" clause names in backticks, de-duplicated, in order. The clause runs to
 *  the next ` · `, labelled part or bold label (an owns label, like "**step 2 owns:**", carries on). Only
 *  spans shaped like a path count, `path:lines` read as the path, a brace glob (`a/{b,c}.md`) expanded;
 *  left out: a span after a negation ("no line in `x`", "but not `y`"), a path followed by a `:NN`
 *  citation, and a path inside an aside that cites lines or says what "stays". `dir` is the tree whose
 *  tracked files decide a doubtful name (`a.b.c`, an extensionless name); without it only well-known names count. Empty when
 *  the block has no "owns" part or it names no path. */
export function ownedFiles(block, dir) {
  return readOwns(block, dir).owned;
}

/** The paths the block's "owns" clause names that leave the repository (`ownedFiles` drops them), in order. */
export function outsideOwns(block, dir) {
  return readOwns(block, dir).outside;
}

/** Does the owns clause name the word "tests" while no owned path is a test file? */
export function ownsTestsWithoutFile(block, dir) {
  const { owned, named } = readOwns(block, dir);
  return named && !owned.some((path) => TEST_FILE.test(path));
}

function readOwns(block, dir) {
  const text = unfenced(String(block ?? ""));
  let list;
  const tracked = () => {
    list ??= dir ? trackedFiles(dir) : [];
    return list;
  };
  const at = BOLD_OWNS.exec(text) ?? OWNS.exec(text);
  if (!at) return { owned: [], outside: [], named: false };
  let part = text.slice(at.index + at[0].length);
  part = part.slice(0, clauseEnd(part));
  let masked = part.replace(TICKED, (span) => " ".repeat(span.length));
  const excluded = EXCLUSION.exec(masked);
  if (excluded) {
    // Opened after a `(`, it ends at that aside's `)` ("(not more than 200 lines), `b.ts`" still owns b.ts).
    const aside = excluded[0].startsWith("(");
    const close = aside ? masked.indexOf(")", excluded.index) : -1;
    const end = close < 0 ? part.length : close;
    const blank = (text) =>
      text.slice(0, excluded.index) + " ".repeat(end - excluded.index) + text.slice(end);
    part = blank(part);
    masked = blank(masked);
  }
  const out = [];
  const outside = [];
  let from = 0;
  let negated = false;
  // Past the leading list of paths, a sentence that says its paths are out of scope drops them: those
  // after prose, and those in an aside that says it.
  const outer = outsideAsides(masked);
  const raw = outsideAsides(part);
  const cuts = [
    ...[...outer.matchAll(SENTENCE_PART)].map((m) => m.index),
    ...[...outer.matchAll(LIST_ITEM)].map((m) => m.index),
    ...[...outer.matchAll(STEP_AT)].map((m) => m.index),
    ...sentenceEnds(part),
  ].sort((x, y) => x - y);
  let tail = false;
  let seen = false;
  let heads = [];
  for (const m of part.matchAll(TICKED)) {
    const span = m[1].replace(/\s*\n\s*/g, "");
    const between = part.slice(from, m.index);
    // The words between the previous span and this one, in this clause only, a closed aside
    // ("(no new class)") left out.
    const clause = between.split(/;|\.\s|\n\s*\n|\n\s*[-*]\s/).at(-1);
    from = m.index + m[0].length;
    const bare = heads.length > 0 && BARE_EXTENSION.test(span) && SIBLING_GAP.test(between);
    if (seen && !bare && !LIST_GAP.test(between.replace(/\([^()]*\)/g, " ").replace(/,/g, " ")))
      tail = true;
    seen = true;
    const prior = heads;
    heads = [];
    // A negation holds to the next comma: a span right after a comma ("not `a`, `b`") shares the
    // previous span's reading, but words after a comma ("`a`, without touching x, `b`") end it.
    const pieces = clause.replace(/\([^()]*\)/g, " ").split(",");
    const last = pieces.at(-1);
    const joined =
      pieces.length > 1 && clause === between && !clause.includes(")") && LIST_GAP.test(last);
    negated = joined ? negated : NEGATION.test(last);
    if (negated) continue;
    // A path cited with a `:NN` right after it, or inside an aside that cites lines or says what
    // "stays", is context the contract mentions, not a file it owns.
    if (CITED.test(part.slice(from)) || CONTEXT_ASIDE.test(asideAt(part, masked, m.index)))
      continue;
    const before = asideAt(part, masked, m.index, true).replace(TICKED, " ");
    if (
      (tail && saysOut({ outer, raw }, cuts, m.index, Boolean(before))) ||
      OUT_OF_SCOPE.test(before)
    )
      continue;
    if (bare) {
      // Each extension adds a sibling of the path before the first one.
      heads = prior;
      for (const path of prior) {
        const sibling = path.replace(/\.[^./]*$/, span);
        if (!out.includes(sibling)) out.push(sibling);
      }
      continue;
    }
    for (const one of braced(span)) {
      const path = pathOf(one, tracked);
      const list = path && leaves(path) ? outside : out;
      if (path && !list.includes(path)) list.push(path);
      if (path && list === out) heads.push(path);
    }
  }
  return { owned: out, outside, named: TESTS_WORD.test(masked) };
}

const trackedFiles = (dir) => {
  try {
    return execFileSync("git", ["-C", dir, "ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }
};

// Where `path` sits in the tracked files: the leading folders its fixed part is found under ("" when
// it is at the root). The fixed part is the whole path, or for a glob or folder the folders before the
// first `*` or `?`; a path with no fixed part (`*.md`) is found nowhere.
function leadsOf(tracked, path) {
  const wild = path.search(/[*?]/);
  const fixed = wild < 0 ? path : path.slice(0, path.lastIndexOf("/", wild) + 1);
  if (!fixed) return [];
  const folder = fixed.endsWith("/");
  const leads = new Set();
  for (const file of tracked) {
    if (folder ? file.startsWith(fixed) : file === fixed) leads.add("");
    else if (folder) {
      const at = file.indexOf(`/${fixed}`);
      if (at >= 0) leads.add(file.slice(0, at + 1));
    } else if (file.endsWith(`/${fixed}`)) leads.add(file.slice(0, file.length - fixed.length));
  }
  return [...leads].sort();
}

// The tracked folders whose last part is `first`, below the root (`tools/pt/` for `pt`), sorted.
function deepFolders(tracked, first) {
  const folders = new Set();
  for (const file of tracked) {
    const parts = file.split("/").slice(0, -1);
    parts.forEach((part, i) => {
      if (i > 0 && part === first) folders.add(`${parts.slice(0, i + 1).join("/")}/`);
    });
  }
  return [...folders].sort();
}

/** `paths` as `{ path, new }`: `new` when the path is a plain file that does not exist in `dir` (a glob
 *  or folder names what is there, so it is never new). A path missing at the root is looked up among the
 *  tracked files as the tail of a path (a bare name, `merge/gating.mjs`, a glob's folders): found at the
 *  root it stays as written; one other place is that path; several are all listed with `ambiguous: true`;
 *  none means a plain file is new and a glob or folder stays as written. A new plain file whose first
 *  folder is absent at the root resolves under the one tracked folder of that name found deeper
 *  (`pt/x.py` → `tools/pt/x.py`, new); with several it stays as written, `ambiguous` listing them. */
export function withNew(dir, paths) {
  let tracked;
  return paths.flatMap((path) => {
    const open = /[*?]/.test(path) || path.endsWith("/");
    if (!open && existsSync(join(dir, path))) return [{ path, new: false }];
    tracked ??= trackedFiles(dir);
    const leads = leadsOf(tracked, path);
    if (leads.length === 0 && !open && path.includes("/")) {
      // A new file whose first folder is not at the root but is one tracked folder deeper lives there.
      const first = path.split("/")[0];
      const deep =
        existsSync(join(dir, first)) || tracked.some((file) => file.startsWith(`${first}/`))
          ? []
          : deepFolders(tracked, first);
      if (deep.length === 1)
        return [{ path: `${deep[0]}${path.slice(first.length + 1)}`, new: true }];
      if (deep.length > 1) return [{ path, new: true, ambiguous: deep.join(", ") }];
    }
    if (leads.length === 0 || leads.includes(""))
      return [{ path, new: !open && leads.length === 0 }];
    const hits = leads.map((lead) => ({ path: `${lead}${path}`, new: false }));
    return hits.length === 1 ? hits : hits.map((hit) => ({ ...hit, ambiguous: true }));
  });
}
