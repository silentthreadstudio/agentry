// Run the plugin's and the repo scripts' node tests with a PATH that holds no `agentry`. The CLIs name
// `agentry` in the next steps they print only when it is this plugin's bin on PATH, so a shell where the
// plugin is enabled (a Claude Code session) would change what the tests read. bin.test.mjs sets its own.
import { spawnSync } from "node:child_process";
import { constants, accessSync } from "node:fs";
import { delimiter, join } from "node:path";

const hasAgentry = (dir) => {
  try {
    accessSync(join(dir, "agentry"), constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const PATH = (process.env.PATH ?? "")
  .split(delimiter)
  .filter((dir) => dir && !hasAgentry(dir))
  .join(delimiter);
const res = spawnSync(
  process.execPath,
  ["--test", "--test-timeout=180000", "plugin/**/*.test.mjs", "scripts/*.test.mjs"],
  {
    stdio: "inherit",
    env: { ...process.env, PATH },
  },
);
process.exit(res.status ?? 1);
