#!/usr/bin/env node
// Agentry plugin gate — validates the plugin payload before commit (doc 09 §5).
// Dependency-free. Exits non-zero on hard errors; warnings don't fail.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// `--version`: print the plugin version and exit (handy for CI / release scripts).
if (process.argv.includes("--version")) {
  const { version } = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  console.log(version);
  process.exit(0);
}

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const frontmatter = (p) => {
  const t = readFileSync(p, "utf8");
  const m = t.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : null;
};
const hasField = (fm, field) => fm != null && new RegExp(`^${field}:`, "m").test(fm);

// 1. plugin.json
const pluginManifest = join(ROOT, ".claude-plugin", "plugin.json");
if (!existsSync(pluginManifest)) {
  err(".claude-plugin/plugin.json missing");
} else {
  const p = readJson(pluginManifest);
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(p.name ?? "")) err(`plugin.json name invalid: ${p.name}`);
  if (p.version && !/^\d+\.\d+\.\d+/.test(p.version)) err(`plugin.json version not semver: ${p.version}`);
}

// 2. marketplace.json
const market = join(ROOT, ".claude-plugin", "marketplace.json");
if (existsSync(market)) {
  const m = readJson(market);
  if (!Array.isArray(m.plugins) || m.plugins.length === 0) err("marketplace.json has no plugins[]");
  for (const pl of m.plugins ?? []) if (!pl.source) err(`marketplace plugin ${pl.name} missing source`);
}

// 3. agents — frontmatter name + description; no forbidden tools allowlist (capability-first, doc 04)
const agentsDir = join(ROOT, "agents");
if (existsSync(agentsDir)) {
  for (const f of readdirSync(agentsDir).filter((f) => f.endsWith(".md"))) {
    const fm = frontmatter(join(agentsDir, f));
    if (!hasField(fm, "name")) err(`agents/${f}: missing frontmatter name`);
    if (!hasField(fm, "description")) err(`agents/${f}: missing frontmatter description`);
    if (hasField(fm, "tools")) warn(`agents/${f}: has a tools: allowlist — Agentry is capability-first (doc 04)`);
  }
}

// 4. commands — frontmatter description
const cmdDir = join(ROOT, "commands");
if (existsSync(cmdDir)) {
  for (const f of readdirSync(cmdDir).filter((f) => f.endsWith(".md"))) {
    if (!hasField(frontmatter(join(cmdDir, f)), "description")) err(`commands/${f}: missing frontmatter description`);
  }
}

// 5. skills — SKILL.md with name + description
const skillsDir = join(ROOT, "skills");
if (existsSync(skillsDir)) {
  for (const d of readdirSync(skillsDir)) {
    const sk = join(skillsDir, d, "SKILL.md");
    if (!existsSync(sk)) {
      err(`skills/${d}: missing SKILL.md`);
      continue;
    }
    const fm = frontmatter(sk);
    if (!hasField(fm, "name")) err(`skills/${d}/SKILL.md: missing name`);
    if (!hasField(fm, "description")) err(`skills/${d}/SKILL.md: missing description`);
  }
}

// 6. dist-lockstep — if memory/src exists, dist must too (warn if it looks stale)
const memSrc = join(ROOT, "packages", "memory", "src");
const memDist = join(ROOT, "packages", "memory", "dist", "index.js");
if (existsSync(memSrc)) {
  if (!existsSync(memDist)) {
    warn("packages/memory/dist/index.js missing — build + commit before the MCP can run (dist-lockstep)");
  } else {
    const newestSrc = readdirSync(memSrc, { recursive: true })
      .map((f) => join(memSrc, String(f)))
      .filter((p) => existsSync(p) && statSync(p).isFile())
      .reduce((mx, p) => Math.max(mx, statSync(p).mtimeMs), 0);
    if (newestSrc > statSync(memDist).mtimeMs) warn("packages/memory/dist is older than src — rebuild + commit (dist-lockstep)");
  }
}

// Report
for (const w of warnings) console.warn(`⚠️  ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`❌ ${e}`);
  console.error(`\ncheck-plugin: ${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
console.log(`✅ check-plugin: OK (${warnings.length} warning(s))`);
