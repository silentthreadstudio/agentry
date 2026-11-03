// Search-readiness guards on the BUILT site: builds into a temp dir, then checks the sitemap,
// robots.txt, llms.txt, JSON-LD, the manifest and its icons, and each page's head. Offline.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { docsGroups } from "../src/lib/docs-nav.ts";
import { INSTALL_COMMANDS, SITE_DESCRIPTION } from "../src/lib/site.ts";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://agentry.silentthreadstudio.com";
let dist = "";

before(() => {
  dist = mkdtempSync(join(tmpdir(), "agentry-web-seo-"));
  // Pin the canonical site so a SITE_URL / BASE_PATH in the environment cannot change the checks.
  execFileSync("pnpm", ["exec", "astro", "build", "--outDir", dist], {
    cwd: WEB,
    stdio: "ignore",
    env: { ...process.env, SITE_URL: ORIGIN, BASE_PATH: "/" },
  });
});
after(() => rmSync(dist, { recursive: true, force: true }));

const read = (path: string) => readFileSync(join(dist, path), "utf8");
const docsRoutes = ["docs/", ...docsGroups.flatMap((g) => g.items.map((i) => i.href))];
const pagePaths = ["", ...docsRoutes]; // every indexable page; "" is the home page

function pagesOf(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(dist, dir), { withFileTypes: true })) {
      if (name.isDirectory() && name.name !== "_astro") walk(join(dir, name.name));
      else if (name.name === "index.html") out.push(dir);
    }
  };
  walk("");
  return out;
}

const meta = (html: string, attr: string, key: string) =>
  html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`))?.[1];
const decodeHtml = (s: string) =>
  s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

test("the sitemap is well-formed and lists every page on the canonical domain, never the 404", () => {
  const index = read("sitemap-index.xml");
  assert.match(index, /^<\?xml version="1\.0" encoding="UTF-8"\?><sitemapindex/);
  const children = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(children.length > 0);
  const urls: string[] = [];
  for (const child of children) {
    assert.ok(child.startsWith(`${ORIGIN}/`), child);
    const xml = read(child.slice(ORIGIN.length + 1));
    assert.match(xml, /<urlset[^>]*>[\s\S]*<\/urlset>\s*$/);
    urls.push(...[...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
  }
  assert.deepEqual(urls.sort(), pagePaths.map((p) => `${ORIGIN}/${p}`).sort());
  for (const url of urls) assert.ok(url.endsWith("/"), `${url} should end in a slash`);
  assert.equal(urls.filter((u) => /404/.test(u)).length, 0);
  // every built page folder is in the sitemap (the 404 is 404.html, not a folder)
  assert.equal(pagesOf().length, urls.length);
});

test("robots.txt allows everything and names the sitemap", () => {
  const robots = read("robots.txt");
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.doesNotMatch(robots, /^Disallow:\s*\S/m);
  assert.match(robots, new RegExp(`^Sitemap: ${ORIGIN}/sitemap-index\\.xml$`, "m"));
});

test("llms.txt follows llmstxt.org: H1, a summary, sections of links with notes to every docs page", () => {
  const txt = read("llms.txt");
  const lines = txt.split("\n");
  assert.match(lines[0], /^# Agentry$/);
  assert.match(lines[2], /^> .+/);
  assert.equal(lines.filter((l) => l.startsWith("# ")).length, 1);
  assert.ok(lines.filter((l) => l.startsWith("## ")).length >= 3);
  for (const route of docsRoutes) {
    assert.match(
      txt,
      new RegExp(`^- \\[[^\\]]+\\]\\(${ORIGIN}/${route}\\): \\S.+$`, "m"),
      `llms.txt must link ${route} with a note`,
    );
  }
  for (const command of INSTALL_COMMANDS) assert.ok(txt.includes(command), command);
  assert.match(txt, /Node 24/);
  assert.match(txt, /MIT/);
});

test("llms-full.txt carries every docs page's text as markdown, and the files stay clean", () => {
  const full = read("llms-full.txt");
  for (const route of docsRoutes) assert.ok(full.includes(`Source: ${ORIGIN}/${route}\n`), route);
  assert.match(full, /^## What's in the box$/m);
  assert.match(full, /\*\*9 agents\*\*/);
  assert.match(full, /\*\*15 skills\*\*/);
  assert.match(full, /\*\*17 board rules\*\*/);
  for (const [name, text] of [
    ["llms.txt", read("llms.txt")],
    ["llms-full.txt", full],
  ]) {
    assert.doesNotMatch(text, /<\/?(div|span|p|code|pre|a)\b/, `${name} has leftover HTML`);
    assert.doesNotMatch(text, /&(#\d+|amp|quot|lt|gt);/, `${name} has undecoded entities`);
    assert.doesNotMatch(
      text,
      /workbench|raccoon|heist|dashboard/i,
      `${name} names something it must not`,
    );
  }
});

test("the home page carries SoftwareApplication and WebSite JSON-LD that parse, with no ratings", () => {
  const blocks = jsonLd(read("index.html"));
  const app = blocks.find((b) => b["@type"] === "SoftwareApplication");
  const site = blocks.find((b) => b["@type"] === "WebSite");
  assert.ok(app && site, "home needs both blocks");
  for (const key of [
    "name",
    "description",
    "applicationCategory",
    "operatingSystem",
    "license",
    "isAccessibleForFree",
    "offers",
    "softwareRequirements",
    "url",
    "sameAs",
    "publisher",
  ]) {
    assert.ok(key in app, `SoftwareApplication.${key}`);
  }
  assert.equal(app.applicationCategory, "DeveloperApplication");
  assert.match(String(app.license), /MIT/);
  assert.equal(app.isAccessibleForFree, true);
  assert.equal((app.offers as { price: string }).price, "0");
  assert.match(String(app.softwareRequirements), /Claude Code/);
  assert.match(String(app.softwareRequirements), /Node\.js 24/);
  assert.deepEqual(app.sameAs, ["https://github.com/silentthreadstudio/agentry"]);
  assert.deepEqual(app.publisher, {
    "@type": "Organization",
    name: "Silent Thread",
    url: "https://silentthreadstudio.com",
  });
  assert.equal(app.url, `${ORIGIN}/`);
  assert.equal(site.url, `${ORIGIN}/`);
  assert.doesNotMatch(
    JSON.stringify(blocks),
    /aggregateRating|review|ratingValue|\d+ (agents|skills|rules)/i,
  );
});

test("docs pages carry a BreadcrumbList ending at the page itself", () => {
  for (const route of docsRoutes) {
    const [crumbs] = jsonLd(read(`${route}index.html`));
    assert.equal(crumbs["@type"], "BreadcrumbList", route);
    const items = crumbs.itemListElement as { position: number; name: string; item: string }[];
    assert.deepEqual(
      items.map((i) => i.position),
      items.map((_, i) => i + 1),
    );
    assert.equal(items[0].item, `${ORIGIN}/`);
    assert.equal(items[1].item, `${ORIGIN}/docs/`);
    assert.equal(items.at(-1)?.item, `${ORIGIN}/${route}`);
  }
});

test("every page has a unique title, a description of at most 160 characters, canonical, og:url and og:locale", () => {
  const titles = new Set<string>();
  const descriptions = new Set<string>();
  for (const path of pagePaths) {
    const html = read(`${path}index.html`);
    const title = html.match(/<title>([^<]+)<\/title>/)?.[1] ?? "";
    const description = decodeHtml(meta(html, "name", "description") ?? "");
    assert.ok(title, `${path} title`);
    assert.ok(
      description.length > 0 && description.length <= 160,
      `${path} description: ${description.length}`,
    );
    assert.ok(!titles.has(title), `duplicate title ${title}`);
    assert.ok(!descriptions.has(description), `duplicate description on ${path}`);
    titles.add(title);
    descriptions.add(description);
    const canonical = `${ORIGIN}/${path}`;
    assert.match(
      html,
      new RegExp(`<link rel="canonical" href="${canonical}"`),
      `${path} canonical`,
    );
    assert.equal(meta(html, "property", "og:url"), canonical, `${path} og:url`);
    assert.equal(meta(html, "property", "og:locale"), "en_US");
    assert.equal(meta(html, "property", "og:image"), `${ORIGIN}/og.png`);
    assert.equal(meta(html, "name", "theme-color"), "#eef0f2");
  }
  assert.ok(SITE_DESCRIPTION.length <= 160);
});

test("the 404 stays out of search: noindex, no canonical, no og:url", () => {
  const html = read("404.html");
  assert.match(html, /<meta name="robots" content="noindex"/);
  assert.doesNotMatch(html, /rel="canonical"/);
  assert.doesNotMatch(html, /property="og:url"/);
  assert.equal(meta(html, "property", "og:locale"), "en_US");
});

test("the head links versioned icons and the manifest, and the manifest's icons exist at their declared sizes", () => {
  const html = read("index.html");
  for (const href of [
    "/favicon.ico?v=2",
    "/favicon.svg?v=2",
    "/apple-touch-icon.png?v=2",
    "/site.webmanifest",
  ]) {
    assert.ok(html.includes(`href="${href}"`), `head must link ${href}`);
  }
  const manifest = JSON.parse(read("site.webmanifest"));
  assert.equal(manifest.name, "Agentry");
  assert.ok(manifest.short_name);
  assert.match(manifest.theme_color, /^#[\da-f]{6}$/i);
  assert.match(manifest.background_color, /^#[\da-f]{6}$/i);
  const purposes = manifest.icons.map((i: { purpose: string }) => i.purpose);
  assert.ok(purposes.includes("any") && purposes.includes("maskable"));
  for (const icon of manifest.icons as { src: string; sizes: string; type: string }[]) {
    assert.match(icon.src, /\?v=\d+$/, "icon URLs carry a version");
    const [w, h] = png(icon.src.replace(/\?.*$/, "")).split("x");
    assert.equal(`${w}x${h}`, icon.sizes, icon.src);
    assert.equal(icon.type, "image/png");
  }
  assert.equal(png("apple-touch-icon.png"), "180x180");
});

test("favicon.ico holds 16, 32 and 48 px frames", () => {
  const ico = readFileSync(join(dist, "favicon.ico"));
  assert.equal(ico.readUInt16LE(2), 1, "type: icon");
  const count = ico.readUInt16LE(4);
  const sizes = Array.from({ length: count }, (_, i) => ico.readUInt8(6 + 16 * i));
  assert.deepEqual(sizes, [16, 32, 48]);
  assert.ok(existsSync(join(dist, "favicon.svg")));
});

test("vercel.json sets clean trailing-slash URLs, cache rules and the safe headers", () => {
  const config = JSON.parse(readFileSync(join(WEB, "vercel.json"), "utf8"));
  assert.equal(config.trailingSlash, true);
  assert.equal(config.cleanUrls, true);
  const rules = JSON.stringify(config.headers);
  for (const needle of [
    "immutable",
    "X-Content-Type-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "llms",
  ]) {
    assert.ok(rules.includes(needle), needle);
  }
});

/** The JSON-LD blocks in a page, parsed. */
function jsonLd(html: string): Record<string, unknown>[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) =>
    JSON.parse(m[1]),
  );
}

/** A PNG's `WxH`, read from its IHDR chunk. */
function png(path: string): string {
  const buf = readFileSync(join(dist, path));
  assert.equal(buf.subarray(1, 4).toString(), "PNG", path);
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}
