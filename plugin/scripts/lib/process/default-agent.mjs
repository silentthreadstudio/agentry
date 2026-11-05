// default-agent — the project's default main-session agent: reads and merge-writes `"agent":
// "agentry:conductor"` in `<root>/.claude/settings.json`, and checks that it resolves. The only
// `.claude/` I/O in the process kit. Set per project, never in the plugin's own `settings.json` (a
// plugin-level `agent` would take over every session where the plugin is enabled).
//
// readSettings(root) -> { file, data } | { file, error }
// writeAgent(root, { pluginRoot }) -> { file, wrote } | { file, error }   2-space JSON, other keys kept
// verifyStatic(current, { pluginRoot }) -> { resolved, how }
// resolvedFrom(stream, current) -> { resolved, how }   PURE: reads a `claude -p` stream-json run
// verifyLive(root, current, { claude }) -> { resolved, how }
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "../fs/atomic.mjs";

export const AGENT = "agentry:conductor";
const [PLUGIN, NAME] = AGENT.split(":");
/** The plugin this script ships in: `plugin/scripts/lib/process/` → `plugin/`. */
export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const LIVE_ARGS = [
  "-p",
  "ok",
  "--output-format",
  "stream-json",
  "--verbose",
  "--max-turns",
  "1",
];
const LIVE_TIMEOUT_MS = 180_000;

export const settingsFile = (root) => join(root, ".claude", "settings.json");
export const agentFile = (pluginRoot = PLUGIN_ROOT) => join(pluginRoot, "agents", `${NAME}.md`);

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The parsed settings, `{}` for no file. A file that is not a JSON object is an `error`, never `{}`. */
export function readSettings(root) {
  const file = settingsFile(root);
  // A broken symlink would be followed by the write to wherever it points (the plugin ships no
  // settings.json, so a link to it is always broken).
  if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() && !existsSync(file))
    return { file, error: "a broken symlink" };
  if (!existsSync(file)) return { file, data: {} };
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { file, error: `not valid JSON (${e.message})` };
  }
  if (!isObject(data)) return { file, error: "not a JSON object" };
  return { file, data };
}

/** The `agent` in `.claude/settings.local.json`, which Claude Code applies over the project's settings.json;
 *  `undefined` when that file or key is absent or unreadable. */
export function localAgent(root) {
  const file = join(root, ".claude", "settings.local.json");
  if (!existsSync(file)) return undefined;
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return isObject(data) ? data.agent : undefined;
  } catch {
    return undefined;
  }
}

// Same file on disk (covers hard links, which a real-path comparison misses).
function sameFile(a, b) {
  const sa = statSync(a, { throwIfNoEntry: false });
  const sb = statSync(b, { throwIfNoEntry: false });
  return Boolean(sa && sb && sa.dev === sb.dev && sa.ino === sb.ino);
}

// The real path a write to `file` would land on (its parent's real path when it does not exist yet).
function landsOn(file) {
  if (existsSync(file)) return realpathSync(file);
  let dir = dirname(file);
  const tail = [basename(file)];
  while (!existsSync(dir)) {
    tail.unshift(basename(dir));
    dir = dirname(dir);
  }
  return join(realpathSync(dir), ...tail);
}

/** Sets the agent in the project's settings: an existing `agent` keeps its place, a new one goes last.
 *  Writes nothing when it is already set, when the file is not a JSON object, or when the write would
 *  land on the plugin's own `settings.json`. */
export function writeAgent(root, { pluginRoot = PLUGIN_ROOT } = {}) {
  const read = readSettings(root);
  if (read.error) return read;
  const { file, data } = read;
  const own = join(pluginRoot, "settings.json");
  if (landsOn(file) === landsOn(own) || sameFile(file, own))
    return { file, error: "is the plugin's own settings.json; the agent is set per project" };
  if (data.agent === AGENT) return { file, wrote: false };
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Through the whole file: a settings.json that is a link (a dotfiles setup) stays a link.
    const target = existsSync(file) ? realpathSync(file) : file;
    atomicWrite(target, `${JSON.stringify({ ...data, agent: AGENT }, null, 2)}\n`);
  } catch (e) {
    return { file, error: `cannot write (${e.code ?? e.message})` };
  }
  return { file, wrote: true };
}

const shown = (v) => (v === undefined ? "unset" : JSON.stringify(v));

/** No request: the value is exact and the plugin's agent file exists. */
export function verifyStatic(current, { pluginRoot = PLUGIN_ROOT } = {}) {
  if (current !== AGENT)
    return { resolved: "no", how: `static: the name is wrong: agent is ${shown(current)}` };
  const file = agentFile(pluginRoot);
  if (!existsSync(file)) return { resolved: "no", how: `static: ${file} does not exist` };
  return { resolved: "yes", how: `static: agent is "${AGENT}" and ${file} exists` };
}

/** Reads the `system/init` event of a stream-json run. `agents` lists every agent the session can use,
 *  not the one it runs as, so the settings value must be exact as well as listed. */
export function resolvedFrom(stream, current) {
  const init = stream
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((e) => e?.type === "system" && e.subtype === "init");
  if (!init) return { resolved: "unchecked", how: "live: the run printed no system/init event" };
  const agents = Array.isArray(init.agents) ? init.agents : [];
  const plugins = Array.isArray(init.plugins) ? init.plugins : [];
  if (current === AGENT && agents.includes(AGENT))
    return { resolved: "yes", how: `live: "${AGENT}" is in the system/init agents` };
  if (current !== AGENT)
    return { resolved: "no", how: `live: the name is wrong: agent is ${shown(current)}` };
  if (!plugins.some((p) => p?.name === PLUGIN))
    return { resolved: "no", how: `live: plugin not enabled: "${PLUGIN}" is not loaded here` };
  return {
    resolved: "no",
    how: `live: the name is wrong: plugin "${PLUGIN}" is loaded but has no "${NAME}" agent`,
  };
}

/** One small request: `claude -p "ok"` in the root, read through `resolvedFrom`. */
export function verifyLive(root, current, { claude = "claude" } = {}) {
  const run = spawnSync(claude, LIVE_ARGS, {
    cwd: root,
    encoding: "utf8",
    input: "",
    timeout: LIVE_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error)
    return { resolved: "unchecked", how: `live: could not run ${claude} (${run.error.message})` };
  return resolvedFrom(run.stdout ?? "", current);
}
