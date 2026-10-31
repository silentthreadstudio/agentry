// board default-agent [--write] [--verify [static|live]] — the project's default main-session agent
// (F23), for `/agentry:init`. Prints JSON `{ settings, current, wrote, resolved, how }`: the settings
// file, its `agent` before any write (null when unset), whether this run wrote it, and whether
// `agentry:conductor` resolves ("unchecked" without `--verify`). `--write` sets it (replacing a
// different value) in `<root>/.claude/settings.json`; without it a different value is only reported.
// `--verify` is static (no request); `--verify live` runs one small `claude -p` request in the root and
// reads its system/init event, so it only runs when asked. Needs no process file. Exit 0, 1 when a
// verify did not answer "yes", 2 for a usage error or a settings file that is not a JSON object (never
// overwritten).
//
// run(argv, { root }) -> { exit, out }
import { AGENT, readSettings, verifyLive, verifyStatic, writeAgent } from "../default-agent.mjs";

export const noSpec = true;
export const usage = "default-agent [--write] [--verify [static|live]]";
export const flags = { "--write": false, "--verify": true };
const MODES = ["static", "live"];

// The verify mode: null without `--verify`, "static" when given bare.
function mode(argv) {
  const at = argv.indexOf("--verify");
  if (at < 0) return { mode: null };
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) return { mode: "static" };
  return MODES.includes(value)
    ? { mode: value }
    : { error: `--verify takes ${MODES.join(" or ")}` };
}

export function run(argv, { root, pluginRoot, claude }) {
  const verify = mode(argv);
  if (verify.error) return { exit: 2, out: `${verify.error}\nusage: ${usage}` };
  const read = readSettings(root);
  if (read.error) return { exit: 2, out: `✗ ${read.file}: ${read.error}; not changed` };
  const current = read.data.agent ?? null;
  let wrote = false;
  if (argv.includes("--write")) {
    const written = writeAgent(root, { pluginRoot });
    if (written.error) return { exit: 2, out: `✗ ${written.file}: ${written.error}; not changed` };
    wrote = written.wrote;
  }
  const now = wrote ? AGENT : read.data.agent;
  const check =
    verify.mode === "live"
      ? verifyLive(root, now, { claude })
      : verify.mode === "static"
        ? verifyStatic(now, { pluginRoot })
        : { resolved: "unchecked", how: "not verified: pass --verify (static) or --verify live" };
  const out = { settings: read.file, current, wrote, ...check };
  return { exit: verify.mode && check.resolved !== "yes" ? 1 : 0, out: JSON.stringify(out) };
}
