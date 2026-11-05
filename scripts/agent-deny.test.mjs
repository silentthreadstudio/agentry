// Tests for scripts/lib/agent-deny.mjs: the gate's guard that every specialist agent keeps denying the
// outward publish tools, on synthetic plugin dirs.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { agentsMissingDeny } from "./lib/agent-deny.mjs";

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

// A plugin dir whose agents/ holds `files` (name → frontmatter lines).
function plugin(files) {
  const dir = mkdtempSync(join(tmpdir(), "agent-deny-"));
  temps.push(dir);
  mkdirSync(join(dir, "agents"));
  for (const [name, lines] of Object.entries(files))
    writeFileSync(join(dir, "agents", name), `---\nname: x\n${lines}description: d\n---\nBody\n`);
  return dir;
}

test("agentsMissingDeny is empty when each specialist withholds the three tools, as a string or a list", () => {
  const dir = plugin({
    "a.md": "disallowedTools: Artifact, ArtifactComments, ArtifactData\n",
    "b.md": "disallowedTools:\n  - Artifact\n  - ArtifactComments\n  - ArtifactData\n",
  });
  assert.deepEqual(agentsMissingDeny(dir), []);
});

test("agentsMissingDeny names an agent with no deny field, and one that lost an entry", () => {
  const dir = plugin({
    "a.md": "skills: [x]\n",
    "b.md": "disallowedTools: Artifact, ArtifactData\n",
  });
  assert.deepEqual(agentsMissingDeny(dir), [
    "agents/a.md: disallowedTools does not withhold Artifact",
    "agents/a.md: disallowedTools does not withhold ArtifactComments",
    "agents/a.md: disallowedTools does not withhold ArtifactData",
    "agents/b.md: disallowedTools does not withhold ArtifactComments",
  ]);
});

test("agentsMissingDeny leaves the conductor alone, and does not read a similar tool as a match", () => {
  const dir = plugin({
    "conductor.md": "",
    "a.md": "disallowedTools: ArtifactCheck, ArtifactComments, ArtifactData\n",
  });
  assert.deepEqual(agentsMissingDeny(dir), [
    "agents/a.md: disallowedTools does not withhold Artifact",
  ]);
});

test("the shipped agents all withhold the outward publish tools", () => {
  const plugin = join(dirname(fileURLToPath(import.meta.url)), "..", "plugin");
  assert.ok(readdirSync(join(plugin, "agents")).length > 1);
  assert.deepEqual(agentsMissingDeny(plugin), []);
});
