// Content guards for the site source: what the owner removed stays removed, the security page
// tells the truth about what the site loads, and the header's menu button keeps its contract.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(WEB, "src");
// Generated and git-ignored: not site source.
const SKIP = new Set([join(SRC, "data")]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (SKIP.has(path)) return [];
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const read = (path: string) => readFileSync(join(WEB, path), "utf8");

test("no Workbench, Channels, Flow MCP or dashboard anywhere in the site source", () => {
  const hits: string[] = [];
  for (const file of files(SRC)) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        // The approved landing heading "No dashboard." is the one allowed use.
        const cleaned = line.replace("No dashboard. Your board, read for you.", "");
        if (/workbench|channel|flow mcp|dashboard/i.test(cleaned)) {
          hits.push(`${relative(WEB, file)}:${i + 1}: ${line.trim()}`);
        }
      });
  }
  assert.deepEqual(hits, []);
});

test("the removed docs pages and their nav entries are gone", () => {
  for (const page of ["workbench", "flow", "channels"]) {
    assert.equal(existsSync(join(SRC, "pages", "docs", page)), false, `docs/${page} still exists`);
  }
  const nav = read("src/lib/docs-nav.ts");
  assert.doesNotMatch(nav, /"(flow|workbench|channels)"/);
});

test("no dead references to the removed images, figures or dashboard", () => {
  const dead = /DocDiagram|DocShot|diagrams\/|shots\/|dashboard\//;
  const hits = files(SRC)
    .filter((file) => dead.test(readFileSync(file, "utf8")))
    .map((file) => relative(WEB, file));
  assert.deepEqual(hits, []);
});

test("the security page names what the website loads and that the plugin sends nothing", () => {
  const page = read("src/pages/docs/security/index.astro");
  for (const phrase of ["Vercel Analytics", "Speed", "Insights", "Google Fonts", "sends nothing"]) {
    assert.match(page, new RegExp(phrase), `security page must mention "${phrase}"`);
  }
  assert.doesNotMatch(page, /no analytics backend|no telemetry backend|no analytics or telemetry/i);
});

test("the header menu button is a real disclosure for the links list", () => {
  const nav = read("src/components/Nav.astro");
  const button = nav.match(/<button[\s\S]*?>/)?.[0] ?? "";
  assert.match(button, /type="button"/);
  assert.match(button, /aria-expanded="false"/);
  const controls = button.match(/aria-controls="([^"]+)"/)?.[1];
  assert.ok(controls, "the menu button needs aria-controls");
  assert.match(nav, new RegExp(`<ul id="${controls}"`));
  // Once open, Tab must move from the button straight into the links.
  assert.ok(
    nav.indexOf("<button") < nav.indexOf(`<ul id="${controls}"`),
    "button must precede the list",
  );
});

test("the page sets html.js before first paint so the menu never shifts in", () => {
  const base = read("src/layouts/Base.astro");
  const head = base.slice(base.indexOf("<head>"), base.indexOf("</head>"));
  assert.match(
    head,
    /<script is:inline>document\.documentElement\.classList\.add\("js"\);<\/script>/,
  );
});
