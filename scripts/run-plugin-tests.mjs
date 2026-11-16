// Run the plugin's and the repo scripts' node tests with a PATH that holds no `agentry` of this plugin. The
// CLIs name `agentry` in the next steps they print only when it is this plugin's bin on PATH, so a shell
// where the plugin is enabled (a Claude Code session) would change what the tests read. bin.test.mjs sets
// its own. A dir holding some other `agentry` (npm's global agentry-opencode link beside node) stays: it
// may be the dir of the node running this, and children must run that same node.
import { spawnSync } from "node:child_process";
import { constants, accessSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "bin",
  "agentry",
);

const holdsPluginAgentry = (dir) => {
  try {
    const bin = join(dir, "agentry");
    accessSync(bin, constants.X_OK);
    return realpathSync(bin) === realpathSync(PLUGIN_BIN);
  } catch {
    return false;
  }
};

export const filterPath = (path) =>
  path
    .split(delimiter)
    .filter((dir) => dir && !holdsPluginAgentry(dir))
    .join(delimiter);

if (realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const res = spawnSync(
    process.execPath,
    ["--test", "--test-timeout=180000", "plugin/**/*.test.mjs", "scripts/*.test.mjs"],
    {
      stdio: "inherit",
      env: { ...process.env, PATH: filterPath(process.env.PATH ?? "") },
    },
  );
  process.exit(res.status ?? 1);
}
