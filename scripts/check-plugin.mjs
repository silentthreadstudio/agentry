#!/usr/bin/env node
// Agentry plugin gate — validates the plugin payload before commit (doc 09 §5).
// Dependency-free. Exits non-zero on hard errors; warnings don't fail.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { docFlagProblems } from "./lib/doc-flags.mjs";
import { bundleSrcHash, distHash, parseStamp } from "./lib/src-hash.mjs";

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

// 3. agents — frontmatter name + description; no forbidden tools allowlist (capability-first, doc 04)
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

// 6. dist-lockstep — each committed plugin bundle must track its package src, AND be the bundle its stamp
// was taken over. The MCP src lives in the package; the SHIPPED bundle is built into plugin/<label>/
// (committed with the payload). Content-hash compare, not mtime: git doesn't preserve mtimes, so a
// checkout/squash-merge would otherwise trip a false "dist is stale". build.mjs stamps plugin/<label>/.srchash
// with BOTH hashes (see scripts/lib/src-hash.mjs); this recomputes + compares both:
//
//   - `src`  vs bundleSrcHash — covers the package's own src AND every @agentry/* workspace dep esbuild
//     inlines, so a transitive dep change can't leave the bundle stale yet report green. → WARN.
//   - `dist` vs distHash — reads the committed bundle bytes themselves. → ERROR.
//
// The severity split is deliberate. A src mismatch is a normal working state: you just edited source and
// haven't rebuilt yet, and the developer already knows it — a warning is the right nudge. A dist mismatch
// cannot happen in the course of ordinary work: rebuilding rewrites both hashes together, so the only ways to
// reach it are a `.srchash` committed WITHOUT its rebuilt bundle (partial stage, a revert that took only the
// bundle, a squash that dropped it) or a hand-edited bundle. That is precisely the silent failure this gate
// exists to catch — and a warning that lets the commit through would leave the hole open. It fails the gate.
//
// A stamp that carries no dist hash (the pre-verification format — a bare src hash) is NOT green: it has
// never been dist-verified, so green would be a claim the file cannot support. Warn and ask for a rebuild.
//
// `opts` is forwarded verbatim to bundleSrcHash (additive — mem/flow pass none, so their behavior is
// byte-identical). `label` drives ONLY the summary row (`dist-lockstep (${label})`); warning paths are
// derived from the real distPath/srchashPath (relative to plugin/), so the workbench bundles — which live
// under plugin/workbench/{web,server}/ but want the short rows `web` / `server` — read honestly in both.
// The workbench is one package with two buildable source roots under a single pkgDir (web/src + server/src),
// so we read `srcSubdir` here too: the src-existence guard and the recompute must look at the SAME root the
// build hashed, not a non-existent `pkgDir/src`.
const checkBundle = (pkgDir, distPath, srchashPath, label, opts = {}) => {
  const { srcSubdir = "src" } = opts;
  if (!existsSync(join(pkgDir, srcSubdir))) return;
  const distRel = relative(PLUGIN, distPath);
  const dir = dirname(distRel);
  if (!existsSync(distPath)) {
    warn(`plugin/${distRel} missing — build + commit before the bundle can run (dist-lockstep)`);
    return;
  }
  if (!existsSync(srchashPath)) {
    warn(`plugin/${dir}/.srchash missing — rebuild so dist-lockstep is verifiable`);
    return;
  }
  // null = not a verifiable stamp (the old src-only format, or malformed) — it makes no claim about the bytes.
  const stamp = parseStamp(readFileSync(srchashPath, "utf8"));
  if (!stamp)
    warn(
      `plugin/${dir}/.srchash predates dist verification (src hash only — it says nothing about the committed bundle bytes) — rebuild + commit (dist-lockstep)`,
    );
  // The dist dir is the stamp's own directory: one file for mem/flow/server, a Vite tree for web.
  else if (stamp.dist !== distHash(dirname(distPath)))
    err(
      `plugin/${dir} bundle does NOT match its .srchash stamp — the stamp was committed without its rebuilt bundle, the bundle was hand-edited, or a file was added/removed under it; rebuild + commit (dist-lockstep)`,
    );
  else if (stamp.src !== bundleSrcHash(pkgDir, opts))
    warn(
      `plugin/${dir} is stale (${label} src or a bundled @agentry/* dep changed since last build) — rebuild + commit (dist-lockstep)`,
    );
  else ok(`dist-lockstep (${label})`, "up to date");
};
checkBundle(
  join(ROOT, "packages", "memory"),
  join(PLUGIN, "mem", "index.js"),
  join(PLUGIN, "mem", ".srchash"),
  "mem",
);
checkBundle(
  join(ROOT, "packages", "flow"),
  join(PLUGIN, "flow", "index.js"),
  join(PLUGIN, "flow", ".srchash"),
  "flow",
);
// Workbench — one package (packages/workbench), two committed artifacts. The web bundle is self-contained
// (Vite inlines its third-party deps into static assets → skipWorkspaceDeps); the server bundle keeps the
// @agentry/* walk so a transitive @agentry/flow/src change marks it stale. Both anchor at packages/workbench
// (the home of the package.json whose workspace deps are walked) and select their root via srcSubdir.
checkBundle(
  join(ROOT, "packages", "workbench"),
  join(PLUGIN, "workbench", "web", "index.html"),
  join(PLUGIN, "workbench", "web", ".srchash"),
  "web",
  { srcSubdir: "web/src", skipWorkspaceDeps: true },
);
checkBundle(
  join(ROOT, "packages", "workbench"),
  join(PLUGIN, "workbench", "server", "index.js"),
  join(PLUGIN, "workbench", "server", ".srchash"),
  "server",
  { srcSubdir: "server/src" },
);

// 6b. No workspace package may re-invoke a SIBLING package's script of the same name.
//
// `packages/workbench` used to orchestrate `pnpm --filter @agentry/workbench-web build && … -server build`.
// But web and server are workspace packages in their own right, so `pnpm -r build` reached them directly
// AND through the orchestrator: each artifact built TWICE, concurrently (nothing declares an ordering edge
// between them), into the same output directory. It was invisible for months because the builds are
// content-deterministic — two racing writers happened to produce identical bytes.
//
// It stopped being harmless when `.srchash` started carrying a hash of the whole dist DIRECTORY: a
// `writeStamp` landing mid-build now snapshots a transient tree, and that stamp then hard-fails for
// everyone. So this is a gate, not a style note.
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
// fails the gate: the agents run what the docs say (A39).
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
