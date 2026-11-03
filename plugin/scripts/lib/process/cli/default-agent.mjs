// board default-agent [--apply] [--verify [static|live]] — the project's default main-session agent
// (F23), for `/agentry:init`. Prints JSON `{ settings, current, wrote, resolved, how }`: the settings
// file, its `agent` before any write (null when unset), whether this run wrote it, and whether
// `agentry:conductor` resolves ("unchecked" without `--verify`). `--apply` sets it (replacing a
// different value) in `<root>/.claude/settings.json`; without it a different value is only reported.
// `--verify` is static (no request); `--verify live` runs one small `claude -p` request in the root and
// reads its system/init event, so it only runs when asked. Needs no process file. Exit 0, 1 when a
// verify did not answer "yes", 2 for a usage error or a settings file that is not a JSON object (never
// overwritten).
//
// run(argv, { root }) -> { exit, out }
import { refuse, usageError } from "../../cli/help.mjs";
import {
  AGENT,
  localAgent,
  readSettings,
  verifyLive,
  verifyStatic,
  writeAgent,
} from "../default-agent.mjs";

export const noSpec = true;
export const help = {
  usage: "default-agent [--apply] [--verify [static|live]] [--json]",
  purpose: "The project's default main-session agent in .claude/settings.json, as one JSON object.",
  args: {},
  flags: {
    "--apply": "set agent to agentry:conductor (replacing a different value)",
    "--json": "accepted for symmetry: the output is always JSON",
    "--verify [static|live]":
      "check it resolves: static reads files, live spends one claude -p request",
  },
  exits: {
    0: "printed",
    1: "a verify did not answer yes",
    2: "usage, or a settings file that is not a JSON object (never overwritten)",
  },
  example: "board default-agent --verify",
};
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
  if (verify.error) return usageError("board default-agent", verify.error);
  const read = readSettings(root);
  if (read.error) return refuse(read.file, `${read.error}; not changed`);
  const current = read.data.agent ?? null;
  let wrote = false;
  if (argv.includes("--apply")) {
    const written = writeAgent(root, { pluginRoot });
    if (written.error) return refuse(written.file, `${written.error}; not changed`);
    wrote = written.wrote;
  }
  const now = wrote ? AGENT : read.data.agent;
  const local = localAgent(root);
  const pre = verify.mode ? verifyStatic(now, { pluginRoot }) : null;
  const check =
    verify.mode && local !== undefined && local !== AGENT
      ? {
          resolved: "no",
          how: `.claude/settings.local.json sets agent ${JSON.stringify(local)}, which overrides settings.json`,
        }
      : verify.mode === "live" && pre.resolved !== "yes"
        ? pre // the static check already says no: don't spend a request
        : verify.mode === "live"
          ? verifyLive(root, now, { claude })
          : verify.mode === "static"
            ? pre
            : {
                resolved: "unchecked",
                how: "not verified: pass --verify (static) or --verify live",
              };
  const out = { settings: read.file, current, wrote, ...check };
  return { exit: verify.mode && check.resolved !== "yes" ? 1 : 0, out: JSON.stringify(out) };
}
