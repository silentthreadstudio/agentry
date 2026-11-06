// help — the one help and error format of `board.mjs` and `lane.mjs`. Every subcommand exports
// `help`: `{ usage, purpose, args, flags, exits, example }`; `--help` prints it the same way for all.
// A flag key with a second word (`--why <id>`, `--verify [static|live]`) takes a value: the router
// reads which options a subcommand takes from here, so the help and the parser cannot drift apart.
// An error is one line, `✗ <what>: <why> → <next command>`; exit 0 = ok, 1 = findings / stopped /
// needs the owner, 2 = refused / usage / bad config, the same in every subcommand.
//
// flagsOf(help) -> { "--why": true, "--json": false }        true = takes a value
// renderHelp(cli, sub, help, env?) -> string                      one subcommand
// renderIndex(cli, subs: [{ name, help }]) -> string          `<cli> --help`
// say(what, why, next?) -> string                             the error line
// refuse(what, why, next?) -> { exit: 2, out }                that line as a refusal
// usageError(what, why) -> { exit: 2, out }                   a refusal pointing at `<what> --help`
// PREVIEW                                                     the line a write prints without --apply
// pluginVersion(root?) -> string | null                         the running build's version

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGit } from "../process/git.mjs";
import { nextStep } from "./invoke.mjs";

const PAD = 2;
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// `git -C root …`'s output, trimmed; throws when git fails, can't start or outlasts the timeout.
function git(root, args) {
  const res = runGit(root, args);
  if (res.status !== 0) throw new Error(`git ${args[0]} failed`);
  return res.stdout.trim();
}

// What the running build is past its version: `+<n> (<short HEAD>)`, n the commits on HEAD's
// first-parent line since the commit that last changed plugin.json, and ` dirty` when the plugin tree has
// uncommitted changes. "" when the root is no git checkout (a worktree is one), HEAD is that commit, the
// commit is out of reach (a shallow clone's boundary stands in for it), or git fails.
function buildOf(root) {
  try {
    if (git(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") return "";
    const bump = git(root, ["log", "-1", "--format=%H", "--", ".claude-plugin/plugin.json"]);
    if (!bump) return "";
    const shallow = git(root, ["rev-parse", "--is-shallow-repository"]) === "true";
    if (shallow && git(root, ["log", "-1", "--format=%P", bump]) === "") return "";
    if (git(root, ["rev-parse", "HEAD"]) === bump) return "";
    const n = git(root, ["rev-list", "--count", "--first-parent", `${bump}..HEAD`]);
    const head = git(root, ["rev-parse", "--short", "HEAD"]);
    const dirty = git(root, ["status", "--porcelain", "--", "."]) ? " dirty" : "";
    return `+${n} (${head})${dirty}`;
  } catch {
    return "";
  }
}

/** The running build's version: plugin.json's under `root` (the plugin's own by default), with what the
 *  checkout is past it; when the root holds no plugin.json, the version stamp of the vendored CLI copy
 *  under `bin/.agentry-version` stands in (`agentry init --vendor` writes it); null when neither. */
export function pluginVersion(root = PLUGIN_ROOT) {
  let version;
  try {
    ({ version } = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")));
  } catch {
    try {
      // no plugin manifest beside the running CLI: a vendored copy — one inside the npm package
      // reads the package manifest beside it; an .agentry copy reads the stamp `init --vendor` wrote.
      return (
        packageManifestVersion(root) ??
        (readFileSync(join(root, "bin", ".agentry-version"), "utf8").trim() || null)
      );
    } catch {
      return packageManifestVersion(root) ?? null;
    }
  }
  return `${version}${buildOf(root)}`;
}

/** What a version line says when plugin.json can't be read. */
export const UNKNOWN_VERSION = "(version unknown)";

// The package's vendored copy of this CLI (`packages/agentry-opencode/vendor/scripts/…`, and so any
// copy the npm package runs in) carries no plugin manifest — the npm package's own package.json is
// the running build's manifest instead. The name pins it: some other parent repo's package.json is
// not this build's version and stands in for nothing. Exported once, one reader per fact.
export function packageManifestVersion(root = PLUGIN_ROOT) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "..", "package.json"), "utf8"));
    return manifest.name === "agentry-opencode" ? manifest.version : null;
  } catch {
    return null;
  }
}

// The plugin's version, the one a session that started before a flag changed can check itself against.
const version = () => `agentry plugin ${pluginVersion() ?? UNKNOWN_VERSION}`;

/** The options a subcommand takes, from its help: name → whether it takes a value. */
export function flagsOf(help) {
  return Object.fromEntries(
    Object.keys(help?.flags ?? {}).map((key) => {
      const [name, value] = key.split(" ");
      return [name, Boolean(value)];
    }),
  );
}

// `rows` as two columns, the first padded to the widest.
function table(rows) {
  if (!rows.length) return ["  none"];
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${k.padEnd(width + PAD)}${v}`.trimEnd());
}

/** One subcommand's help: usage, purpose, args, flags, exit codes, one example (as `agentry …` when
 *  the plugin's bin is on PATH, like every next step). */
export function renderHelp(cli, sub, given, env = process.env) {
  const help = given ?? { usage: sub, purpose: "" };
  const usage = [help.usage].flat().map((u) => `${cli} ${u}`);
  return [
    `usage: ${usage.join(`\n${" ".repeat("usage: ".length)}`)}`,
    help.purpose,
    "",
    "args:",
    ...table(Object.entries(help.args ?? {})),
    "flags:",
    ...table(Object.entries(help.flags ?? {})),
    "exits:",
    ...table(Object.entries(help.exits ?? {})),
    "example:",
    `  ${nextStep(help.example ?? "", env)}`,
    "",
    version(),
  ].join("\n");
}

/** `<cli> --help`: every subcommand with its purpose, and the options every one of them takes. */
export function renderIndex(cli, subs) {
  return [
    `usage: ${cli} <subcommand> [--root <git root>] [--process <file>] [--help]`,
    "",
    "subcommands:",
    ...table(subs.map(({ name, help }) => [name, help?.purpose ?? ""])),
    "",
    `${cli} <subcommand> --help prints its args, flags, exit codes and an example.`,
    "--root and --process work with every subcommand: the git root, and the process file",
    "(default <root>/.agentry/process.json); the workflow file is its sibling workflow.json.",
    "",
    version(),
  ].join("\n");
}

/** What a write command prints after its preview: it wrote nothing, and how to write it. */
export const PREVIEW = "preview: nothing written; add --apply to write it";

export const say = (what, why, next) => `✗ ${what}: ${why}${next ? ` → ${nextStep(next)}` : ""}`;
export const refuse = (what, why, next) => ({ exit: 2, out: say(what, why, next) });
/** An old spelling of a flag: `✗ board add: --json is now --fields (0.3) → board add --help`, exit 2. */
export const renamed = (what, old, now, since) =>
  usageError(what, `${old} is now ${now} (${since})`);
export const usageError = (what, why) => refuse(what, why, `${what} --help`);
