// init — the OpenCode adapter's verb: `agentry init --host opencode …` writes that host's payload by
// running the generator (scripts/build-opencode.mjs, never forked), with `--vendor` a runnable copy of
// this CLI under <root>/.agentry/ (init-vendor.mjs), and the trigger block through
// `agentry board instructions --target agents` (OpenCode reads AGENTS.md only; CLAUDE.local.md is never
// offered on this host). The payload source is `--src`, else the sibling `plugin/` of this script's repo
// root, else the nearest parent holding agents/ and a plugin manifest (the agentry-opencode package's
// vendor/ is one, carrying the payload source and generator; a `.agentry/` copy has neither, so it
// refuses there: it cannot generate payloads). Preview by default: the payload is generated into
// a temp probe and compared against the target, the trigger block is shown through the instructions
// verb, and nothing is written. `--apply` runs the same steps for real — vendoring before generation,
// since the generated text then calls the copy — and closes with `agentry board check`, whose findings
// end the run as findings and keep the write. `--global` writes the payload (agents, commands, skills)
// into OpenCode's global config dir instead ($XDG_CONFIG_HOME/opencode, else ~/.config/opencode),
// generated for the `agentry` bin on PATH; it touches no repo (no AGENTS.md block, no board check),
// never removes a file, and the repo's own payload, when present, overrides it. Exit 0 ok, 1 findings, 2 refused; --json prints one
// object over the whole state. Node built-ins only.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitRootOf } from "../process/contract.mjs";
import { mainRoot } from "../process/git.mjs";
import { PREVIEW, renderHelp, say } from "./help.mjs";
import { applyVendor, planVendor, vendorVersion } from "./init-vendor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); // <plugin>/scripts/lib/cli
const HOSTS = ["opencode"];
const WHAT = "init";
const VENDOR_HOME = ".agentry";

const HELP = {
  usage:
    "init --host opencode [--root <git root>] [--src <plugin>] [--vendor | --global] [--apply] [--json]",
  purpose:
    "Write the OpenCode V2 payload, a vendored CLI under .agentry/ (with --vendor) and the AGENTS.md trigger block: preview by default, --apply writes.",
  args: {},
  flags: {
    "--host <host>": "the host (opencode; Claude Code keeps the /agentry:init command flow)",
    "--root <dir>": "the git root (default: the current directory's main checkout)",
    "--src <dir>":
      "the payload source: a plugin dir (agents/ plus .claude-plugin/plugin.json); default: this plugin",
    "--vendor":
      "copy bin/agentry and the scripts its groups run into .agentry/, so the generated payload calls the copy",
    "--global":
      "write the payload into OpenCode's global config dir ($XDG_CONFIG_HOME/opencode, else ~/.config/opencode), not a repo; no AGENTS.md block, no check; not with --vendor",
    "--apply": "write: vendored copy, payload, trigger block, then agentry board check",
    "--json": "print the whole state as one JSON object",
  },
  exits: {
    0: "previewed, or written and agentry board check is green",
    1: "written, but the vendored CLI fails to run, or check has findings (the write stays)",
    2: "refused or usage: an unknown host, no payload source or generator, a refused write",
  },
  example: "agentry init --host opencode --vendor --apply",
};

// `--host/--root/--src` take a value, `--vendor/--global/--apply/--json` do not; anything else, or a repeat, is
// refused. `--flag=value` reads as `--flag value`.
function parseFlags(argv) {
  const valued = new Set(["--host", "--root", "--src"]);
  const switches = new Set(["--vendor", "--global", "--apply", "--json"]);
  const got = {};
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--") || arg === "--")
      return { err: say(WHAT, `takes no argument "${arg}"`, `${WHAT} --help`) };
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg : arg.slice(0, eq);
    const value = eq < 0 ? undefined : arg.slice(eq + 1);
    if (!valued.has(name) && !switches.has(name) && name !== "--help")
      return { err: say(WHAT, `unknown option "${name}"`, `${WHAT} --help`) };
    if (seen.has(name)) return { err: say(WHAT, `"${name}" is given twice`, `${WHAT} --help`) };
    seen.add(name);
    if (switches.has(name)) {
      if (value !== undefined)
        return { err: say(WHAT, `"${name}" takes no value`, `${WHAT} --help`) };
      got[name] = true;
      continue;
    }
    const take = value ?? argv[++i];
    if (take === undefined || take === "" || (value === undefined && String(take).startsWith("--")))
      return { err: say(WHAT, `"${name}" needs a value`, `${WHAT} --help`) };
    got[name] = String(take);
  }
  return { got };
}

// ---------------------------------------------------------------------------
// the payload source and its generator

const parents = (from) => {
  const out = [from];
  for (let dir = from; dirname(dir) !== dir; dir = dirname(dir)) out.push(dirname(dir));
  return out;
};

const isPluginLayout = (dir) =>
  existsSync(join(dir, "agents")) && existsSync(join(dir, ".claude-plugin", "plugin.json"));

// The generator stands in the scripts/ of the repo the plugin belongs to (the dev layout), or in the
// plugin's own scripts/ when a copy ships one.
function generatorBeside(plugin) {
  for (const repo of [dirname(plugin), plugin])
    if (existsSync(join(repo, "scripts", "build-opencode.mjs")))
      return join(repo, "scripts", "build-opencode.mjs");
  return null;
}

// `--src` first (a plugin dir, or a repo root whose plugin/ holds one), else the sibling `plugin/` of
// this script's repo root (the dev layout), else the nearest parent of this script that is itself a
// plugin layout (an installed plugin).
function resolveSource(srcArg) {
  if (srcArg) {
    const src = resolve(srcArg);
    const plugin = isPluginLayout(src)
      ? src
      : existsSync(join(src, "plugin", ".claude-plugin", "plugin.json"))
        ? join(src, "plugin")
        : null;
    if (!plugin)
      return {
        err: `no payload under ${src} (agents/ and .claude-plugin/plugin.json) with --src ${srcArg}`,
      };
    return { src: plugin, generator: generatorBeside(plugin) };
  }
  for (const dir of parents(HERE)) {
    const plugin = join(dir, "plugin");
    // a repo checkout of the plugin, not any stray plugin directory: its repo's scripts/ holds the
    // generator beside it, or source resolution moves on to the layout walk below
    if (
      existsSync(join(plugin, "agents")) &&
      existsSync(join(plugin, ".claude-plugin", "plugin.json")) &&
      existsSync(join(dir, "scripts", "build-opencode.mjs"))
    )
      return { src: plugin, generator: join(dir, "scripts", "build-opencode.mjs") };
  }
  for (const dir of parents(HERE))
    if (isPluginLayout(dir)) return { src: dir, generator: generatorBeside(dir) };
  return { err: "no payload source (a vendored CLI copy carries none)" };
}

// ---------------------------------------------------------------------------
// subprocesses: every one is a whole CLI run, stdio piped, output kept

const cmd = (script, args) =>
  spawnSync(process.execPath, [script, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

const failText = (run) => `${run.stderr ?? ""}${run.stdout ?? ""}`.trim();

// Sorted [path, bytes] of every file under `dir` ([] when the directory is absent).
function filesOf(dir, base = "") {
  const out = [];
  let entries;
  try {
    entries = readdirSync(join(dir, base), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesOf(dir, rel));
    else {
      let bytes = null;
      try {
        bytes = readFileSync(join(dir, rel));
      } catch {
        // unreadable stands as a difference below
      }
      out.push([rel, bytes]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// the steps' results

/** One run's plan, computed against the target without writing anything there: the payload the
 *  generator would produce (a temp probe, compared file by file), what `--vendor` would change, and
 *  the trigger block's plan through the instructions verb — read, never written, in both modes: the
 *  write itself goes after generation, and a refusal here ends the run before any file moves. */
function plan(got, source, root) {
  const probe = mkdtempSync(join(tmpdir(), "agentry-init-"));
  try {
    const gen = cmd(source.generator, [
      "--out",
      probe,
      "--src",
      source.src,
      ...(got["--vendor"] ? ["--vendor"] : []),
    ]);
    if (gen.status !== 0)
      return {
        blocked: true,
        status: gen.status ?? 2,
        why: failText(gen) || `exited ${gen.status ?? "?"}`,
      };
    // the payload: the probe's files against the target's, one change or kept; opencode.jsonc and the
    // root AGENTS.md are the owner's once born, written only when missing
    const payload = { changes: [], kept: 0 };
    for (const [rel, bytes] of filesOf(join(probe, ".opencode"))) {
      if (rel === "opencode.jsonc" && existsSync(join(root, ".opencode", rel))) {
        payload.kept++;
        continue;
      }
      const target = join(root, ".opencode", rel);
      let current = null;
      try {
        current = readFileSync(target);
      } catch {
        current = null;
      }
      const write =
        current === null
          ? "new"
          : bytes === null || current.compare(bytes) !== 0
            ? "rewrite"
            : null;
      if (write) payload.changes.push({ path: `.opencode/${rel}`, write });
      else payload.kept++;
    }
    if (existsSync(join(probe, "AGENTS.md")) && !existsSync(join(root, "AGENTS.md")))
      payload.changes.push({ path: "AGENTS.md", write: "new" });
    const vendored = got["--vendor"]
      ? vendoredState(planVendor(root, source.src))
      : { enabled: false };
    const version = vendorVersion(source.src) ?? "(version unknown)";
    const trigger = runInstructions(source, root, false);
    return { payload, vendored, version, trigger };
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/** The vendored copy's plan for the state (its carried file list is overwritten bytes — the count is
 *  the part the output and the JSON keep). */
const vendoredState = (vendorPlan) => ({
  ...vendorPlan,
  files: vendorPlan.files.length,
  bin: `${VENDOR_HOME}/bin/agentry`,
  enabled: true,
});

/** The trigger block's plan, as one JSON object from the verb that owns it (`--apply` only when the
 *  write is real — its own writes stay all-or-nothing whatever this verb does around them). */
function runInstructions(source, root, apply) {
  const run = cmd(join(source.src, "scripts", "board.mjs"), [
    "instructions",
    "--target",
    "agents",
    ...(apply ? ["--apply"] : []),
    "--root",
    root,
    "--json",
  ]);
  let data = null;
  try {
    data = JSON.parse(run.stdout);
  } catch {
    data = null; // a refusal or a crash: its first line stands under this verb's
  }
  return { exit: run.status ?? 2, data, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

// ---------------------------------------------------------------------------
// --global: the payload in OpenCode's global config dir

/** OpenCode's global config dir: $XDG_CONFIG_HOME/opencode, else ~/.config/opencode. */
const globalDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");

/** The generated agents, commands and skills against the global dir, one change or kept each. With
 *  `write`, the changed files are written; nothing else there is read, rewritten or removed. */
function globalPayload(source, dir, write) {
  const probe = mkdtempSync(join(tmpdir(), "agentry-init-"));
  try {
    const gen = cmd(source.generator, ["--out", probe, "--src", source.src, "--global"]);
    if (gen.status !== 0)
      return {
        blocked: true,
        status: gen.status ?? 2,
        why: failText(gen) || `exited ${gen.status ?? "?"}`,
      };
    const payload = { changes: [], kept: 0 };
    for (const [rel, bytes] of filesOf(join(probe, ".opencode"))) {
      // the config and the root AGENTS.md are repo files: never part of a global payload
      if (rel === "opencode.jsonc" || bytes === null) continue;
      const target = join(dir, rel);
      let current = null;
      try {
        current = readFileSync(target);
      } catch {
        current = null;
      }
      if (current !== null && current.compare(bytes) === 0) {
        payload.kept++;
        continue;
      }
      payload.changes.push({ path: rel, write: current === null ? "new" : "rewrite" });
      if (write) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      }
    }
    return { payload };
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/** `init --host opencode --global`: no repo is read or written. */
function runGlobal(got, source, host, apply, out) {
  const dir = globalDir();
  const done = globalPayload(source, dir, apply);
  if (done.blocked)
    return out(
      done.status === 2 ? 2 : 1,
      `✗ init: the payload generator refused: ${done.why.split("\n")[0]} → node ${source.generator} --help`,
    );
  const { payload } = done;
  const version = vendorVersion(source.src) ?? "(version unknown)";
  if (got["--json"])
    return out(
      0,
      JSON.stringify({
        host,
        global: true,
        dir,
        src: source.src,
        version,
        preview: !apply,
        payload,
        exit: 0,
      }),
    );
  const n = payload.changes.length;
  const lines = [
    `${apply ? "✓ " : ""}init ${host} --global → ${dir}`,
    `  source: ${source.src} (${version})`,
    n === 0
      ? `  payload: in sync (${payload.kept} kept) → ${dir}`
      : `  payload: ${n} change${n === 1 ? "" : "s"} ${apply ? "written" : "(would write)"} (${payload.kept} kept) → ${dir}`,
    ...payload.changes.map(({ path, write }) => `      ${MARK[write] ?? write} ${path}`),
    `  repo: untouched — run ${nextStep(host)} in OpenCode per repo, then agentry init --host ${host} --apply for its AGENTS.md block`,
  ];
  if (!apply) lines.push(PREVIEW);
  return out(0, lines.join("\n"));
}

// ---------------------------------------------------------------------------
// output

const MARK = { new: "new", rewrite: "rewrite" };

/** A fresh repo has no process file yet: the trigger block waits for the host's own init command. */
const NEXT_STEP = {
  opencode: "/agentry/init", // OpenCode names nested commands with a slash
};
const nextStep = (host) => NEXT_STEP[host] ?? "/agentry:init";

function text(state) {
  const apply = state.apply === true;
  const lines = [`${apply ? "✓ " : ""}init ${state.host} → ${state.root}`];
  lines.push(`  source: ${state.src} (${state.version})`);
  const payload = state.payload;
  const inSync = payload.changes.length === 0;
  lines.push(
    inSync
      ? `  payload: in sync (${payload.kept} kept) → .opencode/`
      : `  payload: ${payload.changes.length} change${payload.changes.length === 1 ? "" : "s"} ${apply ? "written" : "(would write)"} (${payload.kept} kept) → .opencode/`,
  );
  for (const { path, write } of payload.changes)
    lines.push(`      ${MARK[write] ?? write} ${path}`);
  const vendored = state.vendored;
  if (vendored?.enabled) {
    lines.push(
      vendored.drift
        ? `  vendor: ${vendored.changed.length} file${vendored.changed.length === 1 ? "" : "s"} → ${VENDOR_HOME}/bin/agentry, ${VENDOR_HOME}/scripts/ (stamp ${vendored.version}, ${apply ? "copied" : "would copy"})`
        : `  vendor: in sync (stamp ${vendored.version})`,
    );
    for (const { path, write } of vendored.changed)
      lines.push(`      ${MARK[write] ?? write} ${path}`);
  }
  if (state.trigger?.skipped)
    lines.push(
      `  trigger block: skipped — run ${nextStep(state.host)} in OpenCode to learn your board, then run this init again to add the AGENTS.md block`,
    );
  else if (state.trigger?.data?.lines?.length)
    lines.push(
      "  trigger block:",
      ...state.trigger.data.lines.filter((l) => l !== PREVIEW).map((l) => `      ${l}`),
    );
  else lines.push("  trigger block: nothing printed by the instructions verb");
  if (state.check) {
    const said = failText(state.check) || `exited ${state.check.status ?? "?"}`;
    const head =
      state.check.status === 0
        ? "check:"
        : state.check.status === 1
          ? "check: findings — the write stays:"
          : "check: could not run:";
    lines.push(`  ${head}`, ...said.split("\n").map((l) => `      ${l}`));
  }
  if (!apply) lines.push(PREVIEW);
  return lines.join("\n");
}

// The same state, for scripts: one object, each step's result with its own JSON shape kept.
function json(state) {
  return JSON.stringify({
    host: state.host,
    root: state.root,
    src: state.src,
    version: state.version,
    preview: state.apply !== true,
    payload: state.payload,
    vendored: state.vendored,
    trigger: state.trigger?.data ?? { exit: state.trigger?.exit ?? 2 },
    ...(state.check
      ? { check: { exit: state.check.status ?? 1, ok: state.check.status === 0 } }
      : {}),
    exit: state.check ? (state.check.status === 0 ? 0 : 1) : 0,
  });
}

/** `agentry init …`: the exit code, the lines printed here. */
export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${renderHelp("agentry", "init", HELP)}\n`);
    return 0;
  }
  const out = (exit, line) => {
    (exit === 2 ? process.stderr : process.stdout).write(`${line}\n`);
    return exit;
  };
  const { got, err } = parseFlags(argv);
  if (err) return out(2, err);
  const host = got["--host"] ?? HOSTS[0];
  if (!HOSTS.includes(host))
    return out(2, say(WHAT, `host "${host}" unknown`, `${WHAT} --host ${HOSTS[0]}`));
  if (got["--global"] && got["--vendor"])
    return out(
      2,
      say(
        WHAT,
        "--global and --vendor do not go together: a global payload falls back to the global agentry bin",
        `${WHAT} --host ${host} --global`,
      ),
    );
  const root = got["--root"]
    ? resolve(got["--root"])
    : (mainRoot(process.cwd()) ?? gitRootOf(process.cwd()) ?? process.cwd());
  const source = resolveSource(got["--src"]);
  if (source.err) return out(2, say(WHAT, source.err, `${WHAT} --src <plugin dir> --root ${root}`));
  if (!source.generator)
    return out(
      2,
      say(WHAT, `no scripts/build-opencode.mjs beside ${source.src}`, `${WHAT} --src <plugin dir>`),
    );
  const apply = got["--apply"] === true;
  if (got["--global"]) return runGlobal(got, source, host, apply, out);
  const state = plan(got, source, root);
  if (state.blocked)
    return out(
      state.status === 2 ? 2 : 1,
      `✗ init: the payload generator refused: ${state.why.split("\n")[0]} → node ${source.generator} --help`,
    );
  // A refusal of the trigger block ends the run before a file is written: the instructions verb and its
  // writers are all-or-nothing, so this stays as clean as the caller's tree was.
  // The one exception: no process file yet (a fresh repo) skips the block and keeps the rest.
  if (state.trigger.exit >= 2) {
    const why =
      state.trigger.data?.lines?.join("; ") ||
      failText(state.trigger) ||
      `exited ${state.trigger.exit}`;
    if (!why.includes("no process file here"))
      return out(2, say(WHAT, `the trigger block refused: ${why}`, nextStep(host)));
    state.trigger = { exit: 0, data: null, skipped: true };
  }
  Object.assign(state, { host, root, src: source.src, apply });
  if (!apply) return out(0, got["--json"] ? json(state) : text(state));
  // --apply, in order: the vendored copy first (the generated text then calls it), the payload, the
  // trigger block (planned above; written below by the verb that owns it), the check — whose findings
  // keep the write.
  let vendored = state.vendored;
  if (vendored.drift) {
    vendored = vendoredState(applyVendor(root, source.src));
  }
  if (vendored.enabled) {
    const bin = join(root, ".agentry", "bin", "agentry");
    const said = cmd(bin, ["--version"]).stdout?.trim();
    if (said !== (vendored.version ?? ""))
      return out(
        1,
        say(
          WHAT,
          `the vendored CLI did not run (no ${vendored.version} from --version)`,
          `node ${bin} --version`,
        ),
      );
  }
  if (state.payload.changes.length) {
    const gen = cmd(source.generator, [
      "--out",
      root,
      "--src",
      source.src,
      ...(got["--vendor"] ? ["--vendor"] : []),
    ]);
    if (gen.status !== 0)
      return out(
        2,
        `✗ init: the payload generator refused: ${failText(gen).split("\n")[0] || `exited ${gen.status}`} → node ${source.generator} --help`,
      );
  }
  // the trigger block, through the verb that owns it: the plan above already showed its refusal
  // without writing, this one writes
  const trigger = state.trigger.skipped ? state.trigger : runInstructions(source, root, true);
  if (trigger.exit >= 2)
    return out(
      2,
      say(
        WHAT,
        `the trigger block refused: ${trigger.data?.lines?.join("; ") || failText(trigger) || `exited ${trigger.exit}`}`,
        nextStep(host),
      ),
    );
  // no process file, no board to check: the same wait as the trigger block
  const check = trigger.skipped
    ? null
    : cmd(join(source.src, "scripts", "board.mjs"), ["check", "--root", root]);
  const final = { ...state, check, vendored, trigger, apply: true };
  return out(!check || check.status === 0 ? 0 : 1, got["--json"] ? json(final) : text(final));
}
