// brief — what an exec round's brief says, rendered from the templates in the conducting skill's
// `references/briefs/` (ADR-R3): the same brief every time, on disk, quoting the board instead of memory.
//
//   ownedFiles      the paths the contract's "owns" clause names (backticked, brace globs expanded,
//                   negations, `:NN`-cited paths, "stays" asides, code fences and paths that leave the
//                   repository left out), in order; given the tree, a dotted symbol is not a path unless
//                   a file matches
//   outsideOwns     the paths of that clause that leave the repository (a `..` segment): the ones
//                   `ownedFiles` dropped for it (a leading-`/` span is dropped silently, never owned)
//   withNew         those paths, each marked `new` when the tree has no such file; a path missing at the
//                   root is looked up among the tree's tracked files as a suffix (`merge/gating.mjs`, a bare
//                   name, a glob's folder): one hit is that path, several are all listed `ambiguous`; a new
//                   file under a first folder found only deeper (`pt/x.py` → `tools/pt/x.py`) goes there
//   suggestBuilder  designer when an owned path is UI-shaped, else implementer (the conductor decides, #20)
//   citedDecisions  every decision of the board's decision kind the block cites by id, the rows that name
//                   the task (decided after the contract was written) and those the owner asked for with
//                   `--cite`, each row quoted
//   appendedAfter   what a brief holds after its last template section (a section the conductor added),
//                   so a rewrite of the brief can put it back
//   relatedNotes    the lines elsewhere that mention the task (amendments), read verbatim with file:line
//   notesSection    those notes as the brief's "Later notes" lines, capped
//   recalledFacts   the memory facts ranked for the owned files, only when `memory.prime` is "all": this
//                   repo's store, the user's own and cross-project (`scope: user|global`) facts,
//                   never another project's
//   stepSlots       the slots a contract with steps fills: the round's run, the owner's answer a
//                   `continue` round carries, the approvals a verifier is told of (all off without steps)
//   policySlots     the repo's policy lines (workflow file `briefs`) for a dispatch, as the brief's section
//   recheckSlots    what a recheck, rebase and resolve brief name: the notes sent back, main's branch and
//                   the range-diff the resolve check reads
//   renderBrief     a template filled; every `{{slot}}` must be given, so a template can't drift silently
//   withSection     a rendered brief with a section put in before its first `## ` section
//   ownerChange     the owner's change a verified lane was sent back with, as a builder's or verifier's section
//
// Reads the board's files and the memory store; writes nothing. Node built-ins only.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rankFacts, readFacts, readMemoryConfig } from "../memory/recall.mjs";
import { readInside } from "../process/read.mjs";
import { own } from "../process/spec/shape.mjs";
import { runText } from "../process/steps.mjs";
import { answerLine } from "./exec-view.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEMPLATES = join(
  HERE,
  "..",
  "..",
  "..",
  "skills",
  "conducting",
  "references",
  "briefs",
);

// The template each dispatch step renders.
const TEMPLATE_OF = {
  build: "build",
  fix: "fix",
  "needs-context": "fix",
  continue: "fix",
  rebase: "rebase",
  verify: "verify",
  recheck: "verify",
  final: "final",
  resolve: "resolve",
};

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

// A fence opens a line with three or more backticks or tildes and closes at the same mark, at least as
// long (an unclosed one runs to the end). The lines inside, and the fence lines, are not prose.
const FENCE = /^\s*(`{3,}|~{3,})/;
function unfenced(text) {
  let open = null;
  return text
    .split("\n")
    .filter((line) => {
      const mark = FENCE.exec(line)?.[1];
      if (!open) {
        open = mark ?? null;
        return !mark;
      }
      if (
        mark &&
        mark[0] === open[0] &&
        mark.length >= open.length &&
        !line.trim().slice(mark.length)
      )
        open = null;
      return false;
    })
    .join("\n");
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

const UI_DIRS = new Set([
  "ui",
  "components",
  "screens",
  "views",
  "pages",
  "styles",
  "theme",
  "themes",
]);
// A glob under one of these names a whole front end (`web/**`), where a plain file there may be anything.
const FRONT_DIRS = new Set(["web", "app", "ui"]);
const UI_EXT = /\.(css|scss|sass|less|vue|svelte|astro|html|tscn)$/i;

/** Which builder the owned paths suggest: `{ agent, why }`. A suggestion: the conductor decides. */
export function suggestBuilder(owned) {
  const ui = owned.find((path) => {
    const parts = path.toLowerCase().split("/");
    return (
      UI_EXT.test(path) ||
      parts.some((part) => UI_DIRS.has(part)) ||
      (/[*?]/.test(path) && parts.slice(0, -1).some((part) => FRONT_DIRS.has(part)))
    );
  });
  return ui
    ? { agent: "designer", why: `${ui} is UI-shaped` }
    : { agent: "implementer", why: "no owned path is UI-shaped" };
}

/** The board's decision kind: the one `drafts.decision` names, else a kind called "decision". */
export function decisionKind(spec) {
  const named = own(own(spec?.drafts, "decision"), "kind");
  if (typeof named === "string" && own(spec?.kinds, named)) return named;
  return own(spec?.kinds, "decision") ? "decision" : null;
}

/** The text of each `related` hit (`{ file, line }`, `file` relative to `root`) as `{ at, text }`, `at`
 *  its `file:line`. A hit whose line can't be read inside the repo is left out. */
export function relatedNotes(root, related) {
  const out = [];
  for (const { file, line } of related ?? []) {
    const text = readInside(root, join(root, file))?.split(/\r?\n/)[line - 1]?.trim();
    if (text) out.push({ at: `${file}:${line}`, text });
  }
  return out;
}

export const NOTES_CAP = 8;
const NOTE_WIDTH = 400;

/** The notes as brief lines (`- file:line: text`), at most `NOTES_CAP`, each line cut at `NOTE_WIDTH`
 *  characters; a final line says how many were left out. Empty for no notes. */
export function notesSection(notes) {
  const lines = (notes ?? []).slice(0, NOTES_CAP).map(({ at, text }) => {
    const cut = text.length > NOTE_WIDTH ? `${text.slice(0, NOTE_WIDTH - 1)}… (cut)` : text;
    return `- ${at}: ${cut}`;
  });
  const more = (notes?.length ?? 0) - NOTES_CAP;
  if (more > 0)
    lines.push(
      `- (capped at ${NOTES_CAP}: ${more} more not shown; run \`board contract\` for all)`,
    );
  return lines.join("\n");
}

const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const mentions = (text, id) =>
  new RegExp(`(?<![A-Za-z0-9_-])${literal(id)}(?![A-Za-z0-9_])`).test(text);

/** Every decision to quote, as `{ id, text }`: `id` as the board writes it (the kind's display `prefix` +
 *  its id, `D12`), `text` its table row quoted from the file (or its fields for a one-file-per-item
 *  kind). A decision is in when the block cites it by id, when its row names the task `task` (a decision
 *  made after the contract was written), or when its id is in `cite` (any case). An id made of digits
 *  only is never matched in prose. */
export function citedDecisions({ root, spec, model, block, task, cite = [] }) {
  const name = decisionKind(spec);
  if (!name) return [];
  const kind = spec.kinds[name];
  const prefix = kind.id?.prefix ?? "";
  const text = String(block ?? "");
  const asked = new Set(cite.map((c) => c.toLowerCase()));
  const named = typeof task === "string" && /[A-Za-z]/.test(task);
  const out = [];
  for (const item of own(model?.kinds, name)?.items ?? []) {
    const id = `${prefix}${item.id}`;
    if (out.some((d) => d.id === id)) continue;
    const quote = () => quoteOf(root, spec, kind, item);
    const prose = /[A-Za-z]/.test(id) && mentions(text, id);
    if (prose || asked.has(id.toLowerCase())) out.push({ id, text: quote() });
    else if (named) {
      const row = quote();
      if (mentions(row, task)) out.push({ id, text: row });
    }
  }
  return out;
}

/** The decision ids in `cite` that name no decision on the board (as written, any case). */
export function unknownCites({ spec, model, cite }) {
  const name = decisionKind(spec);
  const known = new Set(
    (own(model?.kinds, name)?.items ?? []).map((i) =>
      `${spec.kinds[name].id?.prefix ?? ""}${i.id}`.toLowerCase(),
    ),
  );
  return cite.filter((c) => !known.has(c.toLowerCase()));
}

/** What `old` (a brief as it was on disk) holds after the last section of `fresh` (the same brief
 *  rendered again): a section someone appended at the end. The last section's heading is looked for in
 *  `old`, taking the place where the rendered section matches in full. Empty when there is nothing
 *  after it, or the old brief does not match the template. */
export function appendedAfter(old, fresh) {
  const headings = [...fresh.matchAll(/^## .*$/gm)];
  const last = headings.at(-1);
  if (!last) return "";
  const section = fresh.slice(last.index).trimEnd();
  for (let at = old.indexOf(last[0]); at >= 0; at = old.indexOf(last[0], at + 1))
    if (old.startsWith(section, at))
      return old.slice(at + section.length).trim() ? old.slice(at + section.length) : "";
  return "";
}

function quoteOf(root, spec, kind, item) {
  if (kind.at?.table !== undefined) {
    const file = readInside(root, join(root, spec.root ?? ".", item.file));
    const line = file?.split(/\r?\n/)[item.line - 1];
    if (line) return line.trim();
  }
  return Object.entries(item.fields ?? {})
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => `${k}: ${[v].flat().join(", ")}`)
    .join(" · ");
}

// A brief may carry what this repo's store holds, plus the user's own (`scope: user`) and the
// cross-project (`scope: global`) facts from the home store. The home store also keeps facts written
// for other projects (a `repo` fact with no project store goes there) and unscoped ones: those never
// belong in this repo's brief.
export const forThisRepo = (fact) =>
  fact.source === "project" || fact.scope === "user" || fact.scope === "global";

/** How many ranked facts a prime may carry: the config's `primeLimit` when a whole number above 0, else 5. */
export const primeLimitOf = (config) =>
  Number.isInteger(config.primeLimit) && config.primeLimit > 0 ? config.primeLimit : 5;

/** The facts recalled for this contract: `{ prime, facts }`. Facts only when the repo's
 *  `memory.prime` is "all" (briefs are primed); otherwise none. */
export function recalledFacts(root, { owned, block }) {
  const config = readMemoryConfig(root);
  if (config.prime !== "all") return { prime: config.prime, facts: [] };
  const head = String(block ?? "")
    .split("\n")
    .slice(0, 2)
    .join(" ");
  const task = [...owned, head].join(" ");
  return {
    prime: config.prime,
    facts: rankFacts(readFacts(root).filter(forThisRepo), task, primeLimitOf(config)),
  };
}

/** The slots and section names a template uses, in order of first use. */
export const slotsOf = (template) => [
  ...new Set([...template.matchAll(/\{\{[#/]?(\w+)\}\}/g)].map((m) => m[1])),
];

const SECTION = /^\{\{#(\w+)\}\}\n([\s\S]*?)^\{\{\/\1\}\}\n?/gm;

/** `template` with every `{{slot}}` filled from `values`. A section `{{#name}}` … `{{/name}}` (each
 *  marker on its own line) is kept only when `values[name]` is truthy. A slot or section without a
 *  value is an error, never left blank. A line that is only a slot whose value is empty goes, with the
 *  blank line after it, so an absent part leaves no gap; the values themselves are put in as given. */
export function fill(template, values) {
  const missing = slotsOf(template).filter((s) => !Object.hasOwn(values, s));
  if (missing.length) throw new Error(`brief slots without a value: ${missing.join(", ")}`);
  const lines = template
    .replace(SECTION, (_, name, body) => (values[name] ? body : ""))
    .split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const only = /^\{\{(\w+)\}\}$/.exec(lines[i].trim());
    if (only && String(values[only[1]]) === "") {
      if (lines[i + 1]?.trim() === "") i++;
      continue;
    }
    kept.push(lines[i]);
  }
  return `${kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\{\{(\w+)\}\}/g, (_, s) => String(values[s]))
    .trimEnd()}\n`;
}

// A fix round's brief wraps the build brief, a final round's the verify brief: each rule is written once.
const WRAPS = { fix: "build", final: "verify" };
const read = (name) => readFileSync(join(TEMPLATES, `${name}.md`), "utf8");
const body = (text) => text.replace(/^# .*\n+/, "");

/** The brief for dispatch `step`, rendered from its template (with the brief it wraps as `{{inner}}`). */
export function renderBrief(step, values) {
  const name = Object.hasOwn(TEMPLATE_OF, step) ? TEMPLATE_OF[step] : null;
  if (!name) throw new Error(`no brief template for step "${step}"`);
  const inner = Object.hasOwn(WRAPS, name) ? body(fill(read(WRAPS[name]), values)) : "";
  return fill(read(name), { ...values, inner });
}

/** The repo-policy slots for dispatch `step`: the workflow file's `briefs` list for its role (`build` for a
 *  builder's step, the rebase included; `verify` for a verifier's, the resolve check included), each line a
 *  bullet, printed as written. No list, no section.
 *  With the workflow file's `locks`, the time-limit rule's lock line (`locked`): `lockTake` is the take
 *  command, the lock named when there is one, else `<name>` and the names. */
export function policySlots(spec, step) {
  const name = Object.hasOwn(TEMPLATE_OF, step) ? TEMPLATE_OF[step] : null;
  const role = ["build", "fix", "rebase"].includes(name) ? "build" : "verify";
  const lines = own(own(spec, "briefs"), role) ?? [];
  const locks = Object.keys(own(spec, "locks") ?? {});
  const lockTake =
    locks.length === 1
      ? `\`agentry lock take ${locks[0]}\``
      : `\`agentry lock take <name>\` (${locks.join(", ")})`;
  return {
    policy: lines.length > 0,
    policyLines: bullets(lines),
    locked: locks.length > 0,
    lockTake: locks.length ? lockTake : "",
  };
}

/** The slots a recheck, rebase and resolve brief fill: `sentBack` the labels of the notes sent back (the
 *  picked ones, or every `N<k>` of the FAIL report), `mainBranch`, and `rangeDiff` the range-diff file the
 *  resolve check judges ("" when there is none). */
export const recheckSlots = ({ sentBack = [], mainBranch = "main", rangeDiff = "" } = {}) => ({
  sentBack: sentBack.length ? sentBack.join(", ") : "none: your report labelled no note",
  mainBranch,
  rangeDiff,
});

const NOT_THIS_ROUND_WIDTH = 100;

/** The slots of a contract built in steps (`process/steps.mjs`) for dispatch `step` on run `stepRun`
 *  (`[a, g]`), with the owner's answers so far (`holds`, the ledger's). A lane without steps gets every
 *  section off. `fresh` is false for a resent round, which carries no new section. */
export function stepSlots({ steps = [], stepRun = null, holds = [], step, fresh = true }) {
  const total = steps.length;
  const run = total && stepRun ? steps.slice(stepRun[0] - 1, stepRun[1]) : [];
  const later = run.length ? steps.slice(stepRun[1]) : [];
  const accept = run.flatMap((s) => s.accept);
  const cut = (t) => (t.length > NOT_THIS_ROUND_WIDTH ? `${t.slice(0, NOT_THIS_ROUND_WIDTH)}…` : t);
  const answer = step === "continue" && fresh ? holds.at(-1) : null;
  const approvals = holds.filter((h) => h.for === "owner" && h.when === "after" && !h.redo);
  return {
    stepped: run.length > 0,
    thisRun: run.length ? runText(stepRun, total) : "",
    runSteps: run.map((s) => `${s.n}. ${s.text}`).join("\n"),
    runAccept: accept.length
      ? bullets(accept)
      : "the step's own text above; the whole acceptance is checked after the last step",
    builtBefore:
      run.length && stepRun[0] > 1
        ? `Built before this round (on the branch): ${stepRun[0] === 2 ? "step 1" : `steps 1–${stepRun[0] - 1}`}.`
        : "",
    notThisRound: later.length
      ? later.map((s) => `step ${s.n}: ${cut(s.text)}`).join("; ")
      : "none: the verifier then reads the whole contract",
    ownerGate: run.at(-1)?.gate === "owner",
    noted: !!answer,
    answer: answer ? `"${answer.note}" (${answer.resumedAt})` : "",
    answerNext: !answer
      ? ""
      : answer.redo
        ? "Rework the same steps to that answer; the lane holds for the owner again when you report."
        : answer.when === "after"
          ? "Go on to the steps below."
          : "Carry on with the same steps, to that answer.",
    // A lane parked mid-round may hold uncommitted work; one parked at a run's end does not.
    parked: answer?.for === "later" && answer.when === "during",
    approved: approvals.length > 0,
    approvals: approvals.map((h) => `- ${answerLine(h, total)}`).join("\n"),
  };
}

/** `text` (a rendered brief) with `section` put in before its first `## ` section, or at the end. */
export function withSection(text, section) {
  const at = text.indexOf("\n## ");
  return at === -1
    ? `${text}\n${section}`
    : `${text.slice(0, at + 1)}${section}\n${text.slice(at + 1)}`;
}

/** The `## The owner's change` section (field 77): the owner's words quoted with their time, and for
 *  `role` "build" what to do with them, for "verify" how to judge the round that made them. */
export function ownerChange({ note, at }, role) {
  const quoted = String(note)
    .split(/\r?\n/)
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
  const what =
    role === "build"
      ? "Make exactly that change, each behavior with a committed test, and leave the rest of the work as it is."
      : "The builder's round you check made that change: judge it as the owner's call, and the rest against the contract. Write one line for it in your report, outside any code block: `owner: PASS <evidence>` or `owner: FAIL <evidence>`.";
  return [
    "## The owner's change",
    "",
    `The owner sent the verified lane back at ${at}:`,
    "",
    quoted,
    "",
    what,
    "",
  ].join("\n");
}

/** A list as brief lines (`- item`), or `none`. */
export const bullets = (items) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "none");

/** `text` as one POSIX shell word: single-quoted, each `'` written `'\''`. */
export const shellQuote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;
