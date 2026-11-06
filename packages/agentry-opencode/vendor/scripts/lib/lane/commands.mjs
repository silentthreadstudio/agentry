// commands — the lane command line a step prints for the conductor to run as written: `agentry lane …`
// when `agentry` on PATH is this plugin's own bin, else `node '<abs>/lane.mjs' …`. Every printed lane
// line is built here, so the two forms cannot drift apart.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prefix } from "../cli/invoke.mjs";
import { shellQuote as q } from "../text/shell.mjs";

/** The lane CLI's own script. */
export const LANE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "lane.mjs");

/** `lane <words>`, then `--root '<root>'` when a root is given, then `extra`. */
export const laneCommand = (words, { root = null, extra = "" } = {}) =>
  `${prefix("lane", `node ${q(LANE)}`)} ${words}${root === null ? "" : ` --root ${q(root)}`}${extra}`;
