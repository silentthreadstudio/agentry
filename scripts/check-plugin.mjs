#!/usr/bin/env node
// Agentry plugin gate — validates the plugin payload before commit (doc 09 §5).
// Dependency-free. Exits non-zero on hard errors; warnings don't fail.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleSrcHash } from "./lib/src-hash.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The shipped plugin payload lives in `plugin/` (marketplace `source: "./plugin"`) = CLAUDE_PLUGIN_ROOT.
// Only `marketplace.json` stays at the repo ROOT; everything else the plugin loads is under PLUGIN.
const PLUGIN = join(ROOT, "plugin");

// `--version`: print the plugin version and exit (handy for CI / release scripts).
if (process.argv.includes("--version")) {
  const { version } = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));
  console.log(version);
  process.exit(0);
}

// Color, gated on an interactive TTY (and not NO_COLOR) so piped/CI output stays plain.
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c("2", s);
const bold = (s) => c("1", s);
const green = (s) => c("32", s);
const red = (s) => c("31", s);
const yellow = (s) => c("33", s);

const errors = [];
const warnings = [];
const checks = []; // { name, detail } — one row per section validated, for the summary
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);
const ok = (name, detail) => checks.push({ name, detail });

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const frontmatter = (p) => {
  const t = readFileSync(p, "utf8");
  const m = t.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : null;
};
const hasField = (fm, field) => fm != null && new RegExp(`^${field}:`, "m").test(fm);

// 1. plugin.json
const pluginManifest = join(PLUGIN, ".claude-plugin", "plugin.json");
if (!existsSync(pluginManifest)) {
  err(".claude-plugin/plugin.json missing");
} else {
  const p = readJson(pluginManifest);
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(p.name ?? "")) err(`plugin.json name invalid: ${p.name}`);
  if (p.version && !/^\d+\.\d+\.\d+/.test(p.version)) err(`plugin.json version not semver: ${p.version}`);
  ok("plugin.json", p.version ? `${p.name} v${p.version}` : p.name);
}

// 2. marketplace.json
const market = join(ROOT, ".claude-plugin", "marketplace.json");
if (existsSync(market)) {
  const m = readJson(market);
  if (!Array.isArray(m.plugins) || m.plugins.length === 0) err("marketplace.json has no plugins[]");
  for (const pl of m.plugins ?? []) if (!pl.source) err(`marketplace plugin ${pl.name} missing source`);
  ok("marketplace.json", `${m.plugins?.length ?? 0} plugin(s)`);
}

// 3. agents — frontmatter name + description; no forbidden tools allowlist (capability-first, doc 04)
const agentsDir = join(PLUGIN, "agents");
if (existsSync(agentsDir)) {
  const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  for (const f of files) {
    const fm = frontmatter(join(agentsDir, f));
    if (!hasField(fm, "name")) err(`agents/${f}: missing frontmatter name`);
    if (!hasField(fm, "description")) err(`agents/${f}: missing frontmatter description`);
    if (hasField(fm, "tools")) warn(`agents/${f}: has a tools: allowlist — Agentry is capability-first (doc 04)`);
  }
  ok("agents", `${files.length} validated`);
}

// 4. commands — frontmatter description
const cmdDir = join(PLUGIN, "commands");
if (existsSync(cmdDir)) {
  const files = readdirSync(cmdDir).filter((f) => f.endsWith(".md"));
  for (const f of files) {
    if (!hasField(frontmatter(join(cmdDir, f)), "description")) err(`commands/${f}: missing frontmatter description`);
  }
  ok("commands", `${files.length} validated`);
}

// 5. skills — SKILL.md with name + description
const skillsDir = join(PLUGIN, "skills");
if (existsSync(skillsDir)) {
  const dirs = readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory());
  for (const d of dirs) {
    const sk = join(skillsDir, d, "SKILL.md");
    if (!existsSync(sk)) {
      err(`skills/${d}: missing SKILL.md`);
      continue;
    }
    const fm = frontmatter(sk);
    if (!hasField(fm, "name")) err(`skills/${d}/SKILL.md: missing name`);
    if (!hasField(fm, "description")) err(`skills/${d}/SKILL.md: missing description`);
  }
  ok("skills", `${dirs.length} validated`);
}

// 6. dist-lockstep — if memory/src exists, dist must too (warn if it looks stale)
// The mem MCP src lives in the package; the SHIPPED bundle is built into plugin/mem/ (committed with the payload).
const memPkg = join(ROOT, "packages", "memory");
const memSrc = join(memPkg, "src");
const memDist = join(PLUGIN, "mem", "index.js");
if (existsSync(memSrc)) {
  if (!existsSync(memDist)) {
    warn("plugin/mem/index.js missing — build + commit before the MCP can run (dist-lockstep)");
  } else {
    // Content-hash compare, not mtime: git doesn't preserve mtimes, so a checkout/squash-merge would
    // otherwise trip a false "dist is stale". build.mjs stamps plugin/mem/.srchash; recompute + compare.
    // bundleSrcHash covers memory's own src AND every @agentry/* workspace dep esbuild inlines (e.g.
    // @agentry/core's dist) — so a transitive dep change can't leave the bundle stale yet report green.
    const stampPath = join(PLUGIN, "mem", ".srchash");
    const stamped = existsSync(stampPath) ? readFileSync(stampPath, "utf8").trim() : "";
    const current = bundleSrcHash(memPkg);
    if (!stamped) warn("plugin/mem/.srchash missing — rebuild so dist-lockstep is verifiable");
    else if (stamped !== current) warn("plugin/mem is stale (memory src or a bundled @agentry/* dep changed since last build) — rebuild + commit (dist-lockstep)");
    else ok("dist-lockstep", "up to date");
  }
}

// 7. hooks.json — events MUST nest under a top-level "hooks" key. The bare form
// (events at the root) parses as valid JSON but silently fails to load — no hook
// ever fires, including SessionStart, with no error anywhere. Catch it here.
const HOOK_EVENTS = new Set([
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse",
  "PostToolUseFailure", "PostToolBatch", "Stop", "StopFailure", "SubagentStart",
  "SubagentStop", "PreCompact", "PostCompact", "Notification", "FileChanged",
]);
const hooksJson = join(PLUGIN, "hooks", "hooks.json");
if (existsSync(hooksJson)) {
  let h;
  try {
    h = readJson(hooksJson);
  } catch (e) {
    err(`hooks/hooks.json: invalid JSON — ${e.message}`);
  }
  if (h) {
    const rootKeys = Object.keys(h);
    if (!("hooks" in h)) {
      // bare form — events at the root with no wrapper → silently never loads
      const looksLikeEvents = rootKeys.some((k) => HOOK_EVENTS.has(k));
      err(looksLikeEvents
        ? `hooks/hooks.json: events (${rootKeys.filter((k) => HOOK_EVENTS.has(k)).join(", ")}) at the root — must nest under a top-level "hooks" key, or NOTHING loads (silent)`
        : `hooks/hooks.json: missing top-level "hooks" key`);
    } else {
      const events = h.hooks;
      let groups = 0;
      for (const [evt, list] of Object.entries(events)) {
        if (!HOOK_EVENTS.has(evt)) warn(`hooks/hooks.json: unknown event "${evt}"`);
        for (const grp of list ?? []) {
          for (const hk of grp.hooks ?? []) {
            groups++;
            // verify any ${CLAUDE_PLUGIN_ROOT}-relative script the hook runs actually exists
            const ref = (hk.command ?? "").match(/\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+?)["\s]/);
            if (ref && !existsSync(join(PLUGIN, ref[1]))) err(`hooks/hooks.json: ${evt} → missing script ${ref[1]}`);
          }
        }
      }
      ok("hooks.json", `${Object.keys(events).length} event(s), ${groups} handler(s)`);
    }
  }
}

// Report
const pad = Math.max(0, ...checks.map((c) => c.name.length));
console.log(bold("\n  Agentry plugin gate"));
for (const { name, detail } of checks) {
  console.log(`  ${green("✓")} ${name.padEnd(pad)}  ${dim(detail)}`);
}
if (warnings.length) {
  console.log("");
  for (const w of warnings) console.warn(`  ${yellow("⚠")}  ${w}`);
}
if (errors.length) {
  console.log("");
  for (const e of errors) console.error(`  ${red("✗")}  ${e}`);
}

const tally = `${errors.length} error(s), ${warnings.length} warning(s)`;
console.log("");
if (errors.length) {
  console.error(`  ${red(bold("FAIL"))} — ${tally}\n`);
  process.exit(1);
}
console.log(`  ${green(bold("OK"))} — ${checks.length} checks passed, ${tally}\n`);
