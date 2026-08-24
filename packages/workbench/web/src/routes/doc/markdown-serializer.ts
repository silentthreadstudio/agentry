// The ONE markdown <-> Tiptap serializer (ADR-004). Markdown is truth; a node opens as a Tiptap
// (ProseMirror) document and every save re-serializes back to markdown. This module is the SINGLE place
// the mapping lives — nothing else parses or emits artifact markdown. It is guarded by the golden
// round-trip corpus (src/test/), the tripwire against silent artifact corruption.
//
// Boundary (ADR-004): frontmatter is split off BEFORE the editor with FLOW's own FRONTMATTER regex; only
// `body` round-trips here. The target shape is standard Tiptap `editor.getJSON()` JSON, so task 16's editor
// consumes/produces it directly. The custom `comment` mark is UI-only and serializes to NOTHING in markdown
// (task 18 owns the mark definition; this module only knows to strip any mark named "comment").
//
// `normalize(body)` is the canonical form, applied identically on first read AND on save output so a no-op
// edit is byte-stable -> identical `computeVersion` -> no false optimistic-concurrency rejection (ADR-006).
// It is defined as the round-trip itself (mdToTiptap -> tiptapToMd), which makes the canonical form
// idempotent by construction.
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

// ── The fixed artifact schema (Tiptap getJSON node/mark names) ────────────────────────────────────────
// Block nodes: doc, paragraph, heading{level}, bulletList, orderedList, listItem, codeBlock{language},
// blockquote, horizontalRule. Inline: text, hardBreak. Marks: bold, italic, code, link{href}, comment.

export interface TiptapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface TiptapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  marks?: TiptapMark[];
  text?: string;
}

/** A Tiptap/ProseMirror document — the root node `editor.getJSON()` returns. */
export interface ProseMirrorDoc {
  type: "doc";
  content: TiptapNode[];
}

// The serializer models exactly this set; anything else is the source-mode escape hatch's job (task 16).
const INLINE_MARKS = new Set(["bold", "italic", "code", "link", "comment"]);

// markdown-it configured to the small, fixed schema. `html: false` keeps raw HTML out of the rich path
// (source-mode handles exotica). No typographic substitution — we must round-trip bytes, not prettify.
const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

// ──────────────────────────────────────────────────────────────────────────────────────────────────────
// md -> Tiptap JSON
// ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Parse a markdown `body` into a Tiptap document (`editor.getJSON()` shape). */
export function mdToTiptap(body: string): ProseMirrorDoc {
  const tokens = md.parse(body, {});
  const content = blocksFromTokens(tokens, 0, tokens.length);
  return { type: "doc", content };
}

// Walk a flat markdown-it token stream over [start, end) and build block nodes. markdown-it emits paired
// `*_open`/`*_close` tokens with children in between; we recurse on the matching close index.
function blocksFromTokens(tokens: Token[], start: number, end: number): TiptapNode[] {
  const nodes: TiptapNode[] = [];
  let i = start;
  while (i < end) {
    const tok = tokens[i];
    if (!tok) {
      i++;
      continue;
    }
    switch (tok.type) {
      case "heading_open": {
        const close = matchingClose(tokens, i, "heading_open", "heading_close");
        const inline = tokens[i + 1];
        const level = Number(tok.tag.slice(1)) || 1;
        nodes.push({
          type: "heading",
          attrs: { level },
          content: inlineFromToken(inline),
        });
        i = close + 1;
        break;
      }
      case "paragraph_open": {
        const close = matchingClose(tokens, i, "paragraph_open", "paragraph_close");
        const inline = tokens[i + 1];
        nodes.push({ type: "paragraph", content: inlineFromToken(inline) });
        i = close + 1;
        break;
      }
      case "bullet_list_open": {
        const close = matchingClose(tokens, i, "bullet_list_open", "bullet_list_close");
        nodes.push({ type: "bulletList", content: listItems(tokens, i + 1, close) });
        i = close + 1;
        break;
      }
      case "ordered_list_open": {
        const close = matchingClose(tokens, i, "ordered_list_open", "ordered_list_close");
        const startAttr = tok.attrGet("start");
        const node: TiptapNode = { type: "orderedList", content: listItems(tokens, i + 1, close) };
        node.attrs = { start: startAttr ? Number(startAttr) : 1 };
        nodes.push(node);
        i = close + 1;
        break;
      }
      case "blockquote_open": {
        const close = matchingClose(tokens, i, "blockquote_open", "blockquote_close");
        nodes.push({ type: "blockquote", content: blocksFromTokens(tokens, i + 1, close) });
        i = close + 1;
        break;
      }
      case "fence":
      case "code_block": {
        const language = tok.info.trim().split(/\s+/)[0] ?? "";
        // markdown-it appends a trailing newline to fence/code content; the codeBlock text drops it.
        const text = tok.content.replace(/\n$/, "");
        const node: TiptapNode = { type: "codeBlock" };
        node.attrs = { language: language || null };
        if (text.length > 0) node.content = [{ type: "text", text }];
        nodes.push(node);
        i++;
        break;
      }
      case "hr": {
        nodes.push({ type: "horizontalRule" });
        i++;
        break;
      }
      default:
        i++;
        break;
    }
  }
  return nodes;
}

// Build listItem nodes between a list's open and close. Each `list_item_open`/`list_item_close` pair wraps
// block content (a paragraph, possibly nested lists) — recursed via blocksFromTokens for nesting.
function listItems(tokens: Token[], start: number, end: number): TiptapNode[] {
  const items: TiptapNode[] = [];
  let i = start;
  while (i < end) {
    if (tokens[i]?.type === "list_item_open") {
      const close = matchingClose(tokens, i, "list_item_open", "list_item_close");
      items.push({ type: "listItem", content: blocksFromTokens(tokens, i + 1, close) });
      i = close + 1;
    } else {
      i++;
    }
  }
  return items;
}

// Find the index of the close token matching the open at `openIdx`, honoring nesting of the same pair.
function matchingClose(tokens: Token[], openIdx: number, openType: string, closeType: string): number {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    const t = tokens[i]?.type;
    if (t === openType) depth++;
    else if (t === closeType) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

// ── Inline tokens -> text nodes with marks ──────────────────────────────────────────────────────────────
// markdown-it nests inline emphasis as paired `*_open`/`*_close` tokens around `text`/`code_inline`. We
// carry an active mark set down the stream and stamp it onto each text node.

function inlineFromToken(inline: Token | undefined): TiptapNode[] {
  if (!inline || !inline.children) return [];
  return inlineNodes(inline.children);
}

function inlineNodes(children: Token[]): TiptapNode[] {
  const out: TiptapNode[] = [];
  const marks: TiptapMark[] = [];
  for (const child of children) {
    switch (child.type) {
      case "text":
        if (child.content.length > 0) out.push(textNode(child.content, marks));
        break;
      case "code_inline":
        out.push(textNode(child.content, [...marks, { type: "code" }]));
        break;
      case "softbreak":
        // A soft line break inside a paragraph renders as a space (markdown's default) — keep it joined.
        out.push(textNode(" ", marks));
        break;
      case "hardbreak":
        out.push({ type: "hardBreak" });
        break;
      case "strong_open":
        marks.push({ type: "bold" });
        break;
      case "strong_close":
        popMark(marks, "bold");
        break;
      case "em_open":
        marks.push({ type: "italic" });
        break;
      case "em_close":
        popMark(marks, "italic");
        break;
      case "link_open": {
        const href = child.attrGet("href") ?? "";
        marks.push({ type: "link", attrs: { href } });
        break;
      }
      case "link_close":
        popMark(marks, "link");
        break;
      default:
        break;
    }
  }
  return out;
}

function popMark(marks: TiptapMark[], type: string): void {
  for (let i = marks.length - 1; i >= 0; i--) {
    if (marks[i]?.type === type) {
      marks.splice(i, 1);
      return;
    }
  }
}

function textNode(text: string, marks: TiptapMark[]): TiptapNode {
  const node: TiptapNode = { type: "text", text };
  if (marks.length > 0) node.marks = marks.map((m) => ({ ...m }));
  return node;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Tiptap JSON -> md  (the canonical emitter — owns normalization byte-for-byte)
// ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Serialize a Tiptap document back to canonical markdown `body` (no frontmatter, no trailing newline). */
export function tiptapToMd(doc: ProseMirrorDoc): string {
  const out = doc.content.map((node) => block(node, "")).filter((s) => s.length > 0);
  // One blank line between top-level blocks; trimmed, no trailing newline (FLOW trims body on read and the
  // file store re-appends the single newline on write — see task-file-store render()).
  return out.join("\n\n").trim();
}

// Serialize one block node. `indent` is the prefix already applied for nested list/blockquote context;
// multi-line block output keeps that prefix on continuation lines.
function block(node: TiptapNode, indent: string): string {
  switch (node.type) {
    case "heading": {
      const level = Number(node.attrs?.["level"]) || 1;
      return `${"#".repeat(level)} ${inline(node.content)}`;
    }
    case "paragraph":
      return inline(node.content);
    case "codeBlock": {
      const lang = typeof node.attrs?.["language"] === "string" ? node.attrs["language"] : "";
      const code = (node.content ?? []).map((n) => n.text ?? "").join("");
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    }
    case "blockquote": {
      const inner = (node.content ?? []).map((n) => block(n, "")).filter((s) => s.length > 0).join("\n\n");
      // Prefix every line with "> " (blank quoted lines stay ">").
      return inner
        .split("\n")
        .map((line) => (line.length > 0 ? `> ${line}` : ">"))
        .join("\n");
    }
    case "bulletList":
      return list(node, indent, () => "- ");
    case "orderedList": {
      const start = Number(node.attrs?.["start"]) || 1;
      return list(node, indent, (i) => `${start + i}. `);
    }
    case "horizontalRule":
      return "---";
    default:
      return "";
  }
}

// Serialize a list. Each listItem's first block sits on the marker line; subsequent blocks (nested lists,
// extra paragraphs) are indented under it. The marker width sets the continuation indent.
function list(node: TiptapNode, indent: string, marker: (index: number) => string): string {
  const items = node.content ?? [];
  const lines: string[] = [];
  items.forEach((item, idx) => {
    const mark = marker(idx);
    const childIndent = indent + " ".repeat(mark.length);
    const blocks = (item.content ?? []).map((child) => block(child, childIndent));
    blocks.forEach((rendered, bIdx) => {
      const renderedLines = rendered.split("\n");
      renderedLines.forEach((line, lIdx) => {
        if (bIdx === 0 && lIdx === 0) {
          lines.push(`${indent}${mark}${line}`);
        } else {
          // Continuation: align under the marker. Nested lists already carry their own indent, so only
          // pad lines that aren't already prefixed past the marker column.
          lines.push(line.length > 0 ? `${childIndent}${line}` : "");
        }
      });
    });
  });
  return lines.join("\n");
}

// ── Inline serialization (marks -> markdown delimiters) ──────────────────────────────────────────────────
// The `comment` mark is stripped (ADR-004: UI-only, serializes to nothing). The hazard a naive per-node
// emitter hits: a single emphasis span split across several text nodes (e.g. `*write contract*` arrives as
// two italic text nodes either side of a soft break). Wrapping each node alone yields `*write** **contract*`
// — silent corruption. So we COALESCE adjacent text nodes that share the same emphasis mark set and wrap the
// whole run once. `code` is innermost (inline code is literal — no nested marks) and never merges across a
// non-code node; `link` is outermost (its [text](href) wraps emphasised text), keyed by href so two
// differently-linked runs don't merge.

const EMPHASIS_ORDER = ["link", "bold", "italic"]; // outer -> inner (code is handled separately, innermost)

function inline(nodes: TiptapNode[] | undefined): string {
  if (!nodes) return "";
  let out = "";
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i];
    if (!node) {
      i++;
      continue;
    }
    if (node.type === "hardBreak") {
      // A hard break is a backslash + newline in markdown; markdown-it re-parses it as `hardbreak`.
      out += "\\\n";
      i++;
      continue;
    }
    if (node.type !== "text" || typeof node.text !== "string") {
      i++;
      continue;
    }
    // Greedily take the maximal run of text nodes carrying the same emphasis key, and wrap it once.
    const key = emphasisKey(node);
    let text = "";
    while (i < nodes.length) {
      const n = nodes[i];
      if (!n || n.type !== "text" || typeof n.text !== "string" || emphasisKey(n) !== key) break;
      text += literal(n);
      i++;
    }
    out += wrapEmphasis(text, node);
  }
  return out;
}

// The literal markdown for one text node's content, with inline `code` applied per-node (code can't merge
// across emphasis boundaries and is the innermost delimiter).
function literal(node: TiptapNode): string {
  const text = node.text ?? "";
  return hasMark(node, "code") ? `\`${text}\`` : text;
}

// A stable key for the run's emphasis marks (bold/italic/link-by-href), EXCLUDING code — code is per-node.
// Two text nodes merge into one emphasis run iff their keys match.
function emphasisKey(node: TiptapNode): string {
  const marks = activeMarks(node).filter((m) => m.type !== "code");
  const parts = marks.map((m) =>
    m.type === "link" ? `link:${String(m.attrs?.["href"] ?? "")}` : m.type,
  );
  return parts.sort().join("|");
}

// Wrap a fully-rendered run in its emphasis delimiters, inner marks first so outer wrap them.
function wrapEmphasis(text: string, sample: TiptapNode): string {
  let out = text;
  for (let i = EMPHASIS_ORDER.length - 1; i >= 0; i--) {
    const type = EMPHASIS_ORDER[i];
    if (!type || !hasMark(sample, type)) continue;
    if (type === "bold") out = `**${out}**`;
    else if (type === "italic") out = `*${out}*`;
    else if (type === "link") {
      const href = linkHref(sample);
      out = `[${out}](${href})`;
    }
  }
  return out;
}

function activeMarks(node: TiptapNode): TiptapMark[] {
  return (node.marks ?? []).filter((m) => INLINE_MARKS.has(m.type) && m.type !== "comment");
}

function hasMark(node: TiptapNode, type: string): boolean {
  return activeMarks(node).some((m) => m.type === type);
}

function linkHref(node: TiptapNode): string {
  const mark = activeMarks(node).find((m) => m.type === "link");
  return typeof mark?.attrs?.["href"] === "string" ? mark.attrs["href"] : "";
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────
// normalize — the canonical form (ADR-004 / ADR-006). Defined AS the round-trip, so it is idempotent by
// construction: normalize(normalize(x)) === normalize(x), and tiptapToMd(mdToTiptap(x)) === normalize(x)
// holds for every input the rich schema models. Applied identically on first read and on save output.
// ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The canonical markdown form of `body` — byte-stable, applied on both read and write. */
export function normalize(body: string): string {
  return tiptapToMd(mdToTiptap(body));
}
