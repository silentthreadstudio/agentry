#!/usr/bin/env node
// Agentry plugin gate — validates the plugin payload before commit.
// Dependency-free. Exits non-zero on hard errors; warnings don't fail.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentsMissingDeny } from "./lib/agent-deny.mjs";
import { docFlagProblems } from "./lib/doc-flags.mjs";
import { privateRefs } from "./lib/private-refs.mjs";
import { missingServerPaths, retiredMentions } from "./lib/retired.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The shipped plugin payload lives in `plugin/` (marketplace `source: "./plugin"`) = CLAUDE_PLUGIN_ROOT.
// Only `marketplace.json` stays at the repo ROOT; everything else the plugin loads is under PLUGIN.
const PLUGIN = join(ROOT, "plugin");

// `--version`: print the plugin version and exit (handy for CI / release scripts).
if (process.argv.includes("--version")) {
  const { version } = JSON.parse(
    readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"),
  );
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
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(p.name ?? ""))
    err(`plugin.json name invalid: ${p.name}`);
  if (p.version && !/^\d+\.\d+\.\d+/.test(p.version))
    err(`plugin.json version not semver: ${p.version}`);
  ok("plugin.json", p.version ? `${p.name} v${p.version}` : p.name);
}

// 2. marketplace.json
const market = join(ROOT, ".claude-plugin", "marketplace.json");
if (existsSync(market)) {
  const m = readJson(market);
  if (!Array.isArray(m.plugins) || m.plugins.length === 0) err("marketplace.json has no plugins[]");
  for (const pl of m.plugins ?? [])
    if (!pl.source) err(`marketplace plugin ${pl.name} missing source`);
  ok("marketplace.json", `${m.plugins?.length ?? 0} plugin(s)`);
}

// 3. agents — frontmatter name + description; no forbidden tools allowlist (capability-first)
const agentsDir = join(PLUGIN, "agents");
if (existsSync(agentsDir)) {
  const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  for (const f of files) {
    const fm = frontmatter(join(agentsDir, f));
    if (!hasField(fm, "name")) err(`agents/${f}: missing frontmatter name`);
    if (!hasField(fm, "description")) err(`agents/${f}: missing frontmatter description`);
    if (hasField(fm, "tools"))
      warn(`agents/${f}: has a tools: allowlist — Agentry is capability-first (doc 04)`);
  }
  ok("agents", `${files.length} validated`);
}

// 4. commands — frontmatter description
const cmdDir = join(PLUGIN, "commands");
if (existsSync(cmdDir)) {
  const files = readdirSync(cmdDir).filter((f) => f.endsWith(".md"));
  for (const f of files) {
    if (!hasField(frontmatter(join(cmdDir, f)), "description"))
      err(`commands/${f}: missing frontmatter description`);
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

// 6. No workspace package may re-invoke a SIBLING package's script of the same name.
//
// A package that orchestrates `pnpm --filter <sibling> build` while the sibling is a workspace package in
// its own right gets built TWICE by `pnpm -r build`: directly AND through the orchestrator, concurrently
// (nothing declares an ordering edge between them), into the same output directory: two racing writers
// whose output only looks right while the builds happen to be content-deterministic.
// The packages `pnpm -r` actually selects — read from pnpm-workspace.yaml, not by walking the tree. The
// walk was wrong: `packages/eval/fixtures/**` holds seed projects with their own package.json that pnpm
// never sees, and a guard that checks a different set than the command it guards is guarding nothing.
// Only the trailing-`*` glob form this repo uses is supported; anything else is reported rather than
// silently skipped, so a future glob style cannot quietly shrink the checked set.
const workspaceManifests = () => {
  const yaml = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const globs = [];
  for (const line of yaml.split("\n")) {
    const m = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/.exec(line);
    if (!m || !m[1].startsWith("packages/")) continue;
    globs.push(m[1]);
  }
  const found = [];
  for (const glob of globs) {
    if (!glob.endsWith("/*")) {
      warn(
        `pnpm-workspace.yaml glob "${glob}" is not the supported <dir>/* form — double-run check skipped it`,
      );
      continue;
    }
    const dir = join(ROOT, glob.slice(0, -2));
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const manifest = join(dir, entry.name, "package.json");
      if (existsSync(manifest)) found.push(manifest);
    }
  }
  return found;
};

const manifests = workspaceManifests()
  .map((file) => {
    try {
      return { file, pkg: JSON.parse(readFileSync(file, "utf8")) };
    } catch {
      return null;
    }
  })
  .filter((m) => m !== null);

const scriptOwners = new Map(); // script name → Set of package names that define it
for (const { pkg } of manifests) {
  for (const name of Object.keys(pkg.scripts ?? {})) {
    if (!scriptOwners.has(name)) scriptOwners.set(name, new Set());
    scriptOwners.get(name).add(pkg.name);
  }
}

let doubleRun = 0;
for (const { pkg } of manifests) {
  for (const [name, body] of Object.entries(pkg.scripts ?? {})) {
    if (typeof body !== "string") continue;
    // `pnpm --filter <target> [--filter <target>…] <name>` — the target also defining `name` means
    // `pnpm -r <name>` runs it twice.
    for (const match of body.matchAll(/--filter\s+(\S+)/g)) {
      const target = match[1];
      if (target === pkg.name) continue;
      if (!body.includes(` ${name}`) && !body.endsWith(name)) continue;
      if (scriptOwners.get(name)?.has(target) !== true) continue;
      doubleRun += 1;
      err(
        `${pkg.name}'s "${name}" re-invokes ${target}'s "${name}" — pnpm -r ${name} then runs it twice, concurrently, with no ordering edge; drop the wrapper and let -r reach the package directly`,
      );
    }
  }
}
if (doubleRun === 0) ok("no double-run scripts", `${manifests.length} package(s) checked`);

// 7. No hooks (one mechanism). Commands, skills and the default conductor agent replace them, so a
// hooks.json — or a "hooks" key in the manifest — fails the gate instead of silently firing from a stale cache.
const hooksJson = join(PLUGIN, "hooks", "hooks.json");
if (existsSync(hooksJson)) {
  err(
    "hooks/hooks.json exists — Agentry ships no hooks; put the behavior in a command, skill or the conductor agent",
  );
}
const manifestHooks = existsSync(pluginManifest) && "hooks" in readJson(pluginManifest);
if (manifestHooks) {
  err('.claude-plugin/plugin.json declares "hooks" — Agentry ships no hooks');
}
if (!existsSync(hooksJson) && !manifestHooks) ok("no hooks", "none shipped");

// 8. Doc flags — a command or skill doc that names a board/lane subcommand or flag the script would refuse
// fails the gate: the agents run what the docs say.
const docProblems = await docFlagProblems(PLUGIN);
for (const p of docProblems) err(`doc flags: ${p}`);
if (!docProblems.length) ok("doc flags", "every board/lane call in the docs is one the CLI takes");

// 9. The `agentry` command — plugin/bin/agentry is what the Bash tool's PATH gets, so it must exist, be
// executable (in git too: an install copies the committed mode), and route the same groups the scripts are.
const bin = join(PLUGIN, "bin", "agentry");
if (!existsSync(bin)) err("bin/agentry missing — the plugin's one command");
else {
  const text = readFileSync(bin, "utf8");
  if (!(statSync(bin).mode & 0o111)) err("bin/agentry is not executable (chmod 755)");
  let tracked = "";
  try {
    tracked = execFileSync("git", ["ls-files", "-s", "--", bin], { cwd: ROOT, encoding: "utf8" });
  } catch {
    // not a git checkout: nothing to compare
  }
  if (tracked && !tracked.startsWith("100755"))
    err("bin/agentry is not mode 100755 in git (git update-index --chmod=+x)");
  for (const group of ["board", "lane"])
    if (!text.includes(`${group}.mjs`) || !existsSync(join(PLUGIN, "scripts", `${group}.mjs`)))
      err(`bin/agentry does not route \`${group}\` to scripts/${group}.mjs`);
  if (!text.includes('"draft"')) err("bin/agentry does not route `draft` to `board draft`");
  ok("bin/agentry", "executable, routes board, lane and draft");
}

// 10. Retired surfaces — no payload file may name the removed web UI, its run-state MCP server, its tools
// or its channels, or a tool of the removed memory MCP server (`mcp__plugin_agentry_mem__…`), and every server the manifest starts must have its bundle (scripts/lib/retired.mjs).
const retired = [...retiredMentions(PLUGIN), ...missingServerPaths(PLUGIN)];
for (const p of retired) err(`plugin/${p}`);
if (!retired.length)
  ok(
    "no retired surfaces",
    "no removed UI, flow or memory MCP tool or channel names; every MCP server bundle exists",
  );

// 11. Import direction — the process kit is the lower layer: lane/ builds on it, so no module under
// scripts/lib/process may import one under scripts/lib/lane (a cycle, and the lane graph loaded by every
// board command). Each relative specifier (static, re-export or dynamic) is resolved before it is judged.
const LIB = join(PLUGIN, "scripts", "lib");
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;
const modulesUnder = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? modulesUnder(join(dir, e.name))
      : /\.m?js$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );
const inward = [];
for (const file of modulesUnder(join(LIB, "process"))) {
  for (const [, spec] of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
    if (!spec.startsWith(".")) continue;
    const to = relative(join(LIB, "lane"), resolve(dirname(file), spec));
    if (!to.startsWith("..") && !isAbsolute(to))
      inward.push(`${relative(PLUGIN, file)} imports lane/${to}`);
  }
}
for (const p of inward) err(`plugin/${p}: process/ must not depend on lane/ (move the leaf down)`);
if (!inward.length) ok("import direction", "nothing under scripts/lib/process imports lib/lane");

// 12. Private references — a comment in a shipped file must say its reason itself, not cite a design doc, an
// ADR, an acceptance-criterion number, a field number, an owner-call id or a task id a reader cannot open
// (scripts/lib/private-refs.mjs).
const privates = privateRefs(ROOT);
for (const p of privates) err(p);
if (!privates.length)
  ok("comments stand alone", "no comment in plugin/ or packages/ cites a private doc");

// 13. Outward publishing — every specialist agent denies the tools that publish a page (scripts/lib/agent-deny.mjs).
const publishing = agentsMissingDeny(PLUGIN);
for (const p of publishing) err(p);
if (!publishing.length)
  ok("agents cannot publish", "each specialist denies Artifact, ArtifactComments and ArtifactData");

// The OpenCode adapter payload must be in sync with plugin/ (one engine, generated per host).
// A stale payload means an edit only reached Claude Code — the dual-host rule's own check.
try {
  execFileSync(process.execPath, [join(ROOT, "scripts", "build-opencode.mjs"), "--check"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  ok("opencode payload in sync", "generated from plugin/, zero drift");
} catch (run) {
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").slice(1);
  err(
    `opencode payload out of sync → node scripts/build-opencode.mjs${out.length ? `\n         ${out.join("\n         ")}` : ""}`,
  );
}

// Package check — packages/agentry-opencode (the omit-one-engine-miss-one rule works both ways): the
// vendor copy (built, never committed) must build fresh from plugin/ (one file-set, two writers), the manifest must
// meet the publish shape (versions equal, zero deps), and the tarball must actually carry the vendored
// core (built just above, so pack runs without its prepack) with its bin executable and nothing the package does not ship.
const OCODE = join(ROOT, "packages", "agentry-opencode");
try {
  execFileSync(process.execPath, [join(ROOT, "scripts", "build-agentry-opencode.mjs")], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  ok("agentry-opencode vendor builds", "built fresh from plugin/ (not committed)");
} catch (run) {
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").slice(1);
  err(
    `agentry-opencode vendor build failed → node scripts/build-agentry-opencode.mjs${out.length ? `\n         ${out.join("\n         ")}` : ""}`,
  );
}

{
  const manifest0 = join(OCODE, "package.json");
  if (!existsSync(manifest0)) {
    err("packages/agentry-opencode/package.json missing");
  } else {
    const m = readJson(manifest0);
    const problems = [];
    if (m.name !== "agentry-opencode")
      problems.push(`name ${JSON.stringify(m.name)} ≠ agentry-opencode`);
    if (m.type !== "module") problems.push("type is not module");
    if (m.license !== "MIT") problems.push(`license ${JSON.stringify(m.license)} ≠ MIT`);
    if (m.version !== readJson(pluginManifest).version)
      problems.push(`version ${m.version} ≠ plugin.json's ${readJson(pluginManifest).version}`);
    if (Object.keys(m.dependencies ?? {}).length)
      problems.push(`ships dependencies: ${Object.keys(m.dependencies).join(" ")}`);
    if (Object.keys(m.devDependencies ?? {}).length)
      problems.push(`ships devDependencies: ${Object.keys(m.devDependencies).join(" ")}`);
    const files = Array.isArray(m.files) ? m.files : [];
    for (const wanted of ["index.js", "src/**", "vendor/**", "README.md"])
      if (!files.includes(wanted)) problems.push(`files whitelist omits ${wanted}`);
    if (m.engines?.node !== ">=24")
      problems.push(`engines.node ${JSON.stringify(m.engines?.node)} ≠ >=24`);
    for (const p of problems) err(`agentry-opencode manifest: ${p}`);
    if (!problems.length)
      ok("agentry-opencode manifest", `${m.name} v${m.version}, engines >=24, zero deps`);
  }
}

{
  let pack = null;
  try {
    const res = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: OCODE,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    // npm versions disagree on the JSON envelope (array, or an object keyed by package name)
    const parsed = JSON.parse(res);
    pack = (Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]) ?? null;
  } catch (run) {
    err(
      `agentry-opencode tarball unreadable → cd packages/agentry-opencode && npm pack --dry-run --json (${(run.stderr ?? "").trim().split("\n")[0] ?? ""})`,
    );
  }
  if (pack) {
    const entries = pack.files ?? [];
    const paths = new Map(entries.map((e) => [e.path.replace(/^package\//, ""), e]));
    const problems = [];
    // npm versions disagree on how a mode is reported: decimal permission bits (493 = 0o755) or the
    // stat mode's octal string ("100755"); either way the bin must be executable in the tarball
    const modeOf = (e) =>
      typeof e.mode === "string" ? e.mode : typeof e.mode === "number" ? e.mode.toString(8) : "";
    const isExecFile = (m) => m === "100755" || m === "755";
    const bin = paths.get("vendor/bin/agentry");
    if (!bin) problems.push("tarball has no vendor/bin/agentry");
    else if (!isExecFile(modeOf(bin)))
      problems.push(`vendor/bin/agentry mode ${modeOf(bin)} is not executable`);
    for (const wanted of [
      "vendor/scripts/lib/memory/persistence/db-index.mjs",
      "vendor/scripts/lib/cli/router.mjs",
    ])
      if (!paths.has(wanted)) problems.push(`tarball has no ${wanted}`);
    for (const [path] of paths)
      if (/(^|\/)(node_modules|test)\//.test(path)) problems.push(`tarball ships ${path}`);
    for (const p of problems) err(`agentry-opencode tarball: ${p}`);
    if (!problems.length)
      ok("agentry-opencode tarball", `${entries.length} entries, the vendored core and its bin in`);
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
