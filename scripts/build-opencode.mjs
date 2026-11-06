#!/usr/bin/env node
// build-opencode — generates OpenCode V2 payload from the Claude Code plugin sources.
//
// plugin/ stays the single source of truth; this script is the thin OpenCode adapter's
// generator: it maps:
//   plugin/agents/*.md   → .opencode/agents/agentry/*.md   (frontmatter mapped; ids namespaced)
//   plugin/commands/*.md → .opencode/commands/agentry/*.md (argument-hint dropped — not a V2 field)
//   plugin/skills/**     → .opencode/skills/**             (markdown rewrites applied)
// and writes .opencode/opencode.jsonc and a root AGENTS.md only when the target lacks one —
// a rerun refreshes generated payload but never clobbers the owner's own files.
//
// Host token rewrites (names only — the logic is untouched):
//   ${CLAUDE_PLUGIN_ROOT} fallback → the plugin root ("plugin")
//   AskUserQuestion → question
//   "agent": "agentry:conductor" / .claude/settings.json → default_agent / .opencode/opencode.jsonc
//   model: inherit → unset (V2 inherits when unset); color names → hex;
//   skills:[] / disallowedTools frontmatter → dropped (skills re-advertised in the body)
//
// usage: node scripts/build-opencode.mjs [--out <repo-root>] [--check]
//   --out    target repo root (default: this repo)
//   --check  regenerate to a temp dir and require zero drift (writes nothing under .opencode/)
// exits: 0 ok / in sync · 1 drift on --check · 2 refused or usage. Node built-ins only.
import { readdir, readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(HERE, ".."); // this repo's root

const USAGE = `usage: node scripts/build-opencode.mjs [--out <repo-root>] [--check]
  --out    target repo root (default: this repo)
  --check  regenerate to a temp dir and require zero drift (no files written)
example: node scripts/build-opencode.mjs --out .`;

const COLORS = {
  blue: "#3b82f6", cyan: "#22d3ee", purple: "#a855f7", red: "#ef4444",
  pink: "#ec4899", orange: "#f97316", yellow: "#eab308", green: "#22c55e",
};

function rewrites(ctx) {
  const { pluginRoot } = ctx;
  return [
    [
      /Shell calls use `agentry`, the plugin's `bin\/` command; where it is not on PATH, run `node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/board\.mjs"` \(or `lane\.mjs`\) with the same arguments\./g,
      `Shell calls use the plugin's \`agentry\` bin \`command\` when it is on PATH; otherwise run \`node "${pluginRoot}/bin/agentry" <board|lane|mem|draft|run|lock> …\` with the same arguments.`,
    ],
    [/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot],
    [/AskUserQuestion/g, "question"],
    [
      /`"agent": "agentry:conductor"` in `\.claude\/settings\.json`/g,
      '`"default_agent": "agentry/conductor"` in `.opencode/opencode.jsonc`',
    ],
    [/\.claude\/settings\.json/g, ".opencode/opencode.jsonc"],
    // command and agent ids: paths, not colons, on OpenCode (agents live under agents/agentry/)
    [/\/agentry:(\w[\w-]*)/g, "/agentry/$1"],
    [/`agentry:conductor`/g, "`agentry/conductor`"],
    [/agent "agentry:([a-z-]+)"/g, 'agent "agentry/$1"'],
    [/Do not re-read AGENTS\.md or CLAUDE\.md: they are already loaded\./g,
      "Do not re-read AGENTS.md: it is already loaded."],
    [/--permission-mode bypassPermissions/g, "opencode run --auto"],
  ];
}

function applyRewrites(text, ctx) {
  for (const [re, to] of rewrites(ctx)) text = text.replace(re, to);
  return text;
}

// ---------------------------------------------------------------------------
// markdown frontmatter: "---\\n...\\n---\\n" → {front, body}
function splitFrontmatter(md) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(md);
  if (!m) return { front: "", body: md };
  return { front: m[1], body: m[2] ?? "" };
}

// agents: keep name/description; map colour to hex; add mode; drop host-only keys.
function mapAgent(src, name, ctx) {
  const { front, body } = splitFrontmatter(src);
  const dropped = [];
  let color = null;
  let skills = null;

  const lines = front.split("\n");
  let keep = [];
  for (const line of lines) {
    if (/^model:\s*inherit\s*$/.test(line)) { dropped.push("model: inherit (unset inherits on OpenCode)"); continue; }
    if (/^disallowedTools:/.test(line)) { dropped.push("disallowedTools (no Artifact tools on OpenCode)"); continue; }
    const sk = /^skills:\s*\[(.+)\]\s*$/.exec(line);
    if (sk) { skills = sk[1].split(",").map(s => s.trim()).filter(Boolean); continue; }
    const c = /^color:\s*(\S+)\s*$/.exec(line);
    if (c) {
      color = COLORS[c[1]];
      if (!color) throw new Error(`✗ build-opencode: unknown colour '${c[1]}' in agents/${name}.md → add it to COLORS`);
      continue;
    }
    keep.push(line);
  }

  // rewrites apply to frontmatter too (descriptions name host settings)
  keep = keep.map((l) => applyRewrites(l, ctx));

  const mode = name === "conductor" ? "primary" : "subagent";
  const frontLines = [
    `# Generated from plugin/agents/${name}.md by scripts/build-opencode.mjs — edit the source, not this file.`,
    `mode: ${mode}`,
    color ? `color: "${color}"` : null,
    ...(dropped.length ? [`# dropped for OpenCode: ${dropped.join("; ")}`] : []),
    ...keep.filter((l) => l.trim() !== ""),
  ].filter((v) => v !== null);

  const outFront = ["---", ...frontLines, "---"].join("\n");
  // name comes from keep (id is the path: agents/agentry/<name>); rewrite the rear keys last
  const bodyOut = applyRewrites(body, ctx).trimStart()
    + (skills && skills.length
      ? `\n\nLoad these skills with the \`skill\` tool when the work needs them: ${skills.join(", ")}.`
      : "");
  return [
    outFront,
    "",
    bodyOut,
  ].join("\n") + "\n";
}

// commands: drop argument-hint (not a V2 field), keep description, rewrite the body.
function mapCommand(src, name, ctx) {
  const { front, body } = splitFrontmatter(src);
  const lines = front.split("\n").filter((l) => !/^argument-hint:/.test(l));
  return [
    `---`,
    // a comment above the frontmatter would break OpenCode's frontmatter parse and leak
    // the whole header into the command's prompt; a YAML comment stays machine-only
    `# Generated from plugin/commands/${name}.md by scripts/build-opencode.mjs — edit the source, not this file.`,
    `${lines.join("\n").trimEnd()}`,
    `---`,
    "",
    applyRewrites(body, ctx).trimStart(),
  ].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// =============================================================================
async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out.sort();
}

async function generate(out, srcRoot = out) {
  // the CLI path hint is spoken from the repo root the agent works in — a function of the
  // source tree's layout, never of the probe/output directory
  const ctx = { pluginRoot: relative(srcRoot, join(srcRoot, "plugin")) || "." };
  const dst = join(out, ".opencode");
  await mkdir(dst, { recursive: true });
  const counts = { agents: 0, commands: 0, skills: 0, config: false };

  const agentsOut = join(dst, "agents", "agentry");
  await mkdir(agentsOut, { recursive: true });
  for (const file of (await readdir(join(srcRoot, "plugin", "agents"))).filter((f) => f.endsWith(".md"))) {
    const name = file.replace(/\.md$/, "");
    await writeFile(join(agentsOut, file), mapAgent(await readFile(join(srcRoot, "plugin", "agents", file), "utf8"), name, ctx));
    counts.agents++;
  }

  const commandsOut = join(dst, "commands", "agentry");
  await mkdir(commandsOut, { recursive: true });
  for (const file of (await readdir(join(srcRoot, "plugin", "commands"))).filter((f) => f.endsWith(".md"))) {
    const name = file.replace(/\.md$/, "");
    await writeFile(join(commandsOut, file), mapCommand(await readFile(join(srcRoot, "plugin", "commands", file), "utf8"), name, ctx));
    counts.commands++;
  }

  const skillsDir = join(dst, "skills");
  await cp(join(srcRoot, "plugin", "skills"), skillsDir, { recursive: true });
  for (const p of await walk(skillsDir)) {
    if (p.endsWith(".md")) {
      await writeFile(p, applyRewrites(await readFile(p, "utf8"), ctx));
      counts.skills++;
    }
  }

  const cfg = join(dst, "opencode.jsonc");
  if (!existsSync(cfg)) {
    await writeFile(cfg, JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      // generated: the conductor opens every next session; set per project, never globally
      default_agent: "agentry/conductor",
      permissions: [
        { action: "external_directory", resource: "*", effect: "ask" },
      ],
    }, null, 2) + "\n");
    counts.config = true;
  }

  const agentsMd = join(out, "AGENTS.md");
  if (!existsSync(agentsMd)) {
    await writeFile(agentsMd, `# Agents

Tasks with a board id go through \`/agentry/exec <id>\`; merges through \`/agentry/merge <id>\`;
questions through \`/agentry/ask\`; a session opens with \`/agentry/start\` and closes with
\`/agentry/close\`. The code bar is CONTRIBUTING.md.

<!-- Written by scripts/build-opencode.mjs (the OpenCode adapter); keep the block above by hand. -->
`);
  }

  return counts;
}

// =============================================================================
function unknownFlags(argv) {
  return argv.filter((a) => (a.startsWith("--") && !/^--(out|check|help)$/.test(a)) || (!a.startsWith("-")));
}

async function check(out) {
  const probe = join(out, ".agcheck");
  await rm(probe, { recursive: true, force: true });
  try {
    await generate(probe, out);
    // compare only generated payload; opencode.jsonc is only-when-missing (owner-owned after birth)
    const a = join(out, ".opencode");
    const drift = [];
    for (const p of await walk(a)) {
      const rel = relative(a, p).replace(/\\/g, "/");
      if (rel === "opencode.jsonc") continue;
      const other = join(probe, ".opencode", rel);
      if (!existsSync(other) || (await readFile(p)).compare(await readFile(other)) !== 0) drift.push(rel);
    }
    for (const p of await walk(join(probe, ".opencode"))) {
      const rel = relative(join(probe, ".opencode"), p).replace(/\\/g, "/");
      if (rel === "opencode.jsonc") continue;
      if (!existsSync(join(a, rel))) drift.push(`absent: ${rel}`);
    }
    if (drift.length) {
      console.error(`✗ build-opencode --check: payload out of sync → node scripts/build-opencode.mjs --out ${out}`);
      for (const d of drift.slice(0, 20)) console.error(`  ${d}`);
      return 1;
    }
    console.log("✓ build-opencode --check: payload in sync");
    return 0;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

export { generate };

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); return 0; }
  const bad = unknownFlags(argv.filter((a) => a !== "--check"));
  if (bad.length) {
    console.error(`✗ build-opencode: unknown argument(s) ${bad.join(" ")} → --help`);
    return 2;
  }
  const i = argv.indexOf("--out");
  const out = resolve(i >= 0 ? argv[i + 1] ?? "." : DEFAULT_OUT);
  if (!existsSync(join(out, "plugin", "agents"))) {
    console.error(`✗ build-opencode: no plugin/ payload under ${out} → --out <repo-root>`);
    return 2;
  }
  if (argv.includes("--check")) return check(out);
  const counts = await generate(out);
  const regen = [];
  if (counts.agents) regen.push(`${counts.agents} agents`);
  if (counts.commands) regen.push(`${counts.commands} commands`);
  if (counts.skills) regen.push(`${counts.skills} skill files`);
  if (counts.config) regen.push("opencode.jsonc (new)");
  console.log(`✓ build-opencode: wrote ${regen.join(", ")} → ${relative(DEFAULT_OUT, join(out, ".opencode"))}`);
  return 0;
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
