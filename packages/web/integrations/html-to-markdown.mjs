// html-to-markdown.mjs — a small converter for the built docs pages: the handful of elements
// the docs use (headings, paragraphs, lists, tables, code, links, notes) and nothing else.
// Dependency-free. Pure: html string in, markdown string out.

const VOID = new Set(["br", "hr", "img", "meta", "link", "input", "wbr"]);
const SKIP = new Set(["script", "style", "nav", "svg", "button", "template"]);
const INLINE = new Set([
  "a",
  "strong",
  "b",
  "em",
  "i",
  "code",
  "span",
  "br",
  "abbr",
  "kbd",
  "mark",
]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code =
        e[1].toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return String.fromCodePoint(code);
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Parse markup into `{ tag, attrs, children }` / `{ text }` nodes. */
export function parse(html) {
  const root = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const token =
    /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+|<)/gi;
  let m = token.exec(html);
  while (m) {
    const [, close, name, rest, text] = m;
    const top = stack[stack.length - 1];
    if (text !== undefined) {
      top.children.push({ text });
    } else if (name && close) {
      const i = stack.map((n) => n.tag).lastIndexOf(name.toLowerCase());
      if (i > 0) stack.length = i;
    } else if (name) {
      const tag = name.toLowerCase();
      const attrs = {};
      for (const a of rest.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
        attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? "");
      }
      const node = { tag, attrs, children: [] };
      top.children.push(node);
      if (!VOID.has(tag) && !rest.trimEnd().endsWith("/")) stack.push(node);
    }
    m = token.exec(html);
  }
  return root;
}

/** First descendant matching `test`, depth first. */
export function find(node, test) {
  if (node.tag && test(node)) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, test);
    if (hit) return hit;
  }
  return null;
}

export const textOf = (node) =>
  node.text !== undefined ? decode(node.text) : node.children.map(textOf).join("");

const hidden = (n) => n.attrs["aria-hidden"] === "true" || SKIP.has(n.tag);
const cls = (n) => (n.attrs.class ?? "").split(/\s+/);

/** Convert one node's children to markdown. `resolve` turns an href into an absolute URL. */
export function toMarkdown(root, resolve = (href) => href) {
  const squash = (s) => s.replace(/\s+/g, " ");

  function inline(node) {
    if (node.text !== undefined) return squash(decode(node.text));
    if (hidden(node)) return "";
    const inner = () => node.children.map(inline).join("");
    switch (node.tag) {
      case "br":
        return "\n";
      case "code": {
        const t = textOf(node).replace(/\s+/g, " ");
        return t ? `\`${t}\`` : "";
      }
      case "strong":
      case "b": {
        const t = inner().trim();
        return t ? `**${t}**` : "";
      }
      case "em":
      case "i": {
        const t = inner().trim();
        return t ? `*${t}*` : "";
      }
      case "a": {
        const t = inner().trim();
        const href = node.attrs.href;
        return href && t ? `[${t}](${resolve(href)})` : t;
      }
      default:
        return inner();
    }
  }

  const para = (nodes) =>
    nodes
      .map(inline)
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .trim();

  function list(node, depth) {
    const ordered = node.tag === "ol";
    const items = node.children.filter((c) => c.tag === "li");
    return items
      .map((li, i) => {
        const marker = ordered ? `${i + 1}. ` : "- ";
        const pad = " ".repeat(marker.length);
        const body = blocks(li.children, depth + 1).join("\n\n");
        return (
          marker +
          body
            .split("\n")
            .map((l, n) => (n === 0 || !l ? l : pad + l))
            .join("\n")
        );
      })
      .join("\n");
  }

  function table(node) {
    const rows = [];
    const walk = (n) => {
      if (n.tag === "tr") {
        rows.push(
          n.children
            .filter((c) => c.tag === "th" || c.tag === "td")
            .map((c) => para(c.children).replace(/\|/g, "\\|").replace(/\n/g, " ")),
        );
      } else for (const c of n.children ?? []) walk(c);
    };
    walk(node);
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.length));
    const line = (r) => `| ${[...r, ...Array(width - r.length).fill("")].join(" | ")} |`;
    return [line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
  }

  function blocks(nodes, depth = 0) {
    const out = [];
    let run = [];
    const flush = () => {
      const p = para(run);
      if (p) out.push(p);
      run = [];
    };
    for (const node of nodes) {
      if (node.text !== undefined || (INLINE.has(node.tag) && !hidden(node))) {
        run.push(node);
        continue;
      }
      if (hidden(node)) continue;
      flush();
      const level = /^h([1-6])$/.exec(node.tag);
      if (level) out.push(`${"#".repeat(Number(level[1]))} ${para(node.children)}`);
      else if (node.tag === "p") out.push(para(node.children));
      else if (node.tag === "ul" || node.tag === "ol") out.push(list(node, depth));
      else if (node.tag === "pre")
        out.push(`\`\`\`\n${visibleText(node).replace(/\n+$/, "")}\n\`\`\``);
      else if (node.tag === "table") out.push(table(node));
      else if (node.tag === "hr") out.push("---");
      else if (node.tag === "div" && cls(node).includes("note")) {
        const body = para(node.children).replace(/\n/g, " ");
        out.push(`> ${body}`);
      } else out.push(...blocks(node.children, depth));
    }
    flush();
    return out.filter(Boolean);
  }

  function visibleText(node) {
    if (node.text !== undefined) return decode(node.text);
    return hidden(node) ? "" : node.children.map(visibleText).join("");
  }

  return blocks(root.children).join("\n\n");
}
