// The live bench must start `claude` WITH the Agentry plugin: `--plugin-dir <repo>/plugin` (where agents, commands,
// skills and the mem MCP live), while the conductor prompt is read from the repo root. A FAKE `claude` on PATH
// records its argv, so the real spawn path runs end to end with ZERO API spend.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { agentryCell } from "../src/conduct/cell.ts";
import { loadOutcomeFixture } from "../src/conduct/fixture.ts";
import { runCell } from "../src/conduct/runner.ts";
import { liveRunner } from "../src/io/live.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const FIXTURE = loadOutcomeFixture(join(HERE, "..", "fixtures", "outcome", "clamp-feature"));

/** Put a fake `claude` first on PATH; it appends its argv as one JSON line to the returned file and settles. */
function installFakeClaude(): { argvFile: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "selfeval-fake-claude-"));
  const argvFile = join(dir, "argv.json");
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log(JSON.stringify({ type: "result", subtype: "success" }));
`,
  );
  chmodSync(bin, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  return {
    argvFile,
    restore: () => {
      process.env.PATH = oldPath;
    },
  };
}

test("the Agentry cell runs claude with --plugin-dir <repo>/plugin and the prompt from the repo root", async () => {
  const fake = installFakeClaude();
  try {
    await runCell(FIXTURE, agentryCell(), liveRunner, { pluginDir: REPO_ROOT, timeoutMs: 20_000 });
  } finally {
    fake.restore();
  }

  const argv = JSON.parse(readFileSync(fake.argvFile, "utf8").trim()) as string[];
  assert.equal(argv[argv.indexOf("--plugin-dir") + 1], join(REPO_ROOT, "plugin"));
  const prompt = argv[argv.indexOf("-p") + 1] ?? "";
  assert.ok(prompt.includes(FIXTURE.prompt), "the task is in the prompt");
  assert.ok(
    !prompt.startsWith("/agentry:go"),
    "the expanded go.md prompt, never the 0-turn slash form",
  );
});

test("a pluginDir that is not the repo root fails loudly instead of running without the plugin", async () => {
  await assert.rejects(
    runCell(FIXTURE, agentryCell(), liveRunner, { pluginDir: join(REPO_ROOT, "plugin") }),
    /plugin\.json not found/,
  );
});
