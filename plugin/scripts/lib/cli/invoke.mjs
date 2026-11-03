// invoke — how the CLIs name themselves in the next steps they print. A plugin's bin/ is on the Bash
// tool's PATH, so when `agentry` there is this plugin's own bin, a next step reads `agentry lane …` /
// `agentry board …`; otherwise it keeps the form it had (`node "<abs>/lane.mjs" …`, or the bare `lane …`).
//
// viaAgentry(env?) -> boolean               does `agentry` on PATH resolve to this plugin's bin
// prefix(cli, fallback, env?) -> string     `agentry <cli>`, or the fallback
// nextStep(text, env?) -> string            the `lane|board <sub>` commands in text, as `agentry …` when it does
import { constants, accessSync, readdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(SCRIPTS, "..", "bin", "agentry");

const real = (file) => {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
};

/** Does the first executable `agentry` on PATH resolve to this plugin's bin? */
export function viaAgentry(env = process.env) {
  const mine = real(BIN);
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const file = join(dir, "agentry");
    try {
      accessSync(file, constants.X_OK);
    } catch {
      continue;
    }
    return mine !== null && real(file) === mine;
  }
  return false;
}

export const prefix = (cli, fallback, env = process.env) =>
  viaAgentry(env) ? `agentry ${cli}` : fallback;

const subs = (...dir) =>
  readdirSync(join(SCRIPTS, "lib", ...dir)).map((f) => f.replace(/\.mjs$/, ""));
let commands;
const pattern = () => {
  if (!commands) {
    const [lane, board] = [subs("lane", "cli"), subs("process", "cli")];
    commands = new RegExp(
      `(?<![\\w/:.-])(?<!agentry )(lane (?:${lane.join("|")})|board (?:${board.join("|")})|(?:lane|board)(?= --help))(?![\\w:-])`,
      "g",
    );
  }
  return commands;
};

export const nextStep = (text, env = process.env) =>
  viaAgentry(env) ? text.replace(pattern(), "agentry $1") : text;
