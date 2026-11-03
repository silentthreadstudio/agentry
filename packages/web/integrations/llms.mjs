// llms.mjs — an Astro integration that writes llms.txt and llms-full.txt into dist/ after the
// build, from the built docs pages themselves, so the two files cannot drift from the site.
//
//   llms.txt       llmstxt.org format: H1, one-line summary, sections of links with a note each.
//   llms-full.txt  the same pages' text, as markdown, in reading order.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCS_OVERVIEW, docsGroups } from "../src/lib/docs-nav.ts";
import { INSTALL_COMMANDS, REPO_URL, SITE_DESCRIPTION, SITE_NAME } from "../src/lib/site.ts";
import { find, parse, textOf, toMarkdown } from "./html-to-markdown.mjs";

const clean = (s) => s.replace(/\s+/g, " ").trim();

/** Read one built page: its title, description, and the article body as markdown. */
function readPage(distDir, route, origin, base) {
  const html = readFileSync(join(distDir, route, "index.html"), "utf8");
  const tree = parse(html);
  const title = clean(textOf(find(tree, (n) => n.tag === "title")));
  const description = clean(
    find(tree, (n) => n.tag === "meta" && n.attrs.name === "description")?.attrs.content ?? "",
  );
  const url = new URL(`${base}${route}/`, origin).href;
  const article = find(tree, (n) => n.tag === "article");
  const heading = clean(textOf(find(article, (n) => n.tag === "h1")));
  const resolve = (href) => (href.startsWith("#") ? url + href : new URL(href, url).href);
  // Drop the eyebrow, the header's own h1 (the page heading is written once, below) and the
  // prev/next nav; keep the lede and everything after it.
  const body = toMarkdown(
    {
      children: article.children.flatMap((c) =>
        c.tag === "header"
          ? c.children.filter((h) => h.tag === "p" && h.attrs.class?.includes("lede"))
          : [c],
      ),
    },
    resolve,
  );
  return { route, title, heading, description, url, body };
}

export function buildLlms({ distDir, site, base = "/" }) {
  const origin = new URL(site).origin;
  const prefix = `/${base.replace(/^\/|\/$/g, "")}/`.replace("//", "/");
  const routes = [DOCS_OVERVIEW.href, ...docsGroups.flatMap((g) => g.items.map((i) => i.href))].map(
    (r) => r.replace(/\/$/, ""),
  );
  const pages = new Map(routes.map((r) => [r, readPage(distDir, r, origin, prefix)]));
  const home = new URL(prefix, origin).href;

  const link = (p, label = p.heading) => `- [${label}](${p.url}): ${p.description}`;
  const overview = pages.get(DOCS_OVERVIEW.href.replace(/\/$/, ""));
  const sections = [
    `## Docs\n\n${link(overview, "Overview")}`,
    ...docsGroups.map(
      (g) =>
        `## ${g.title}\n\n${g.items
          .map((i) => link(pages.get(i.href.replace(/\/$/, "")), i.label))
          .join("\n")}`,
    ),
    `## Source\n\n- [GitHub repository](${REPO_URL}): the plugin, its source and its issues. MIT licensed.`,
  ];

  const index = [
    `# ${SITE_NAME}`,
    `> ${SITE_DESCRIPTION}`,
    [
      "Agentry installs as a Claude Code plugin. It needs Claude Code and Node 24 or newer, and is MIT licensed. Install it from a Claude Code session in your repo:",
      "",
      "```",
      ...INSTALL_COMMANDS,
      "```",
      "",
      `Site: [${home}](${home})`,
    ].join("\n"),
    ...sections,
  ].join("\n\n");

  const full = [
    `# ${SITE_NAME}`,
    `> ${SITE_DESCRIPTION}`,
    ...[...pages.values()].map((p) => `---\n\n# ${p.heading}\n\nSource: ${p.url}\n\n${p.body}`),
  ].join("\n\n");

  return { index: `${index}\n`, full: `${full}\n` };
}

export default function llms() {
  let config;
  return {
    name: "agentry-llms",
    hooks: {
      "astro:config:done": ({ config: c }) => {
        config = c;
      },
      "astro:build:done": ({ dir }) => {
        const distDir = fileURLToPath(dir);
        const { index, full } = buildLlms({ distDir, site: config.site, base: config.base });
        writeFileSync(join(distDir, "llms.txt"), index);
        writeFileSync(join(distDir, "llms-full.txt"), full);
      },
    },
  };
}
