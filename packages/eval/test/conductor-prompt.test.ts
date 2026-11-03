// Tests for `buildConductorPrompt` (conductor-prompt.ts) — the expanded `/agentry:go` prompt every live probe
// sends. Pure fs over the repo's real `plugin/commands/go.md`, ZERO API spend. The probes read the routed shape
// from `.agentry/work/<run>/` files, so the prompt must tell the conductor to write them, with no MCP tool the
// plugin no longer ships.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { AUTOPILOT_DIRECTIVE, buildConductorPrompt } from "../src/conductor-prompt.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TASK = "fix the off-by-one in paginate()";

test("buildConductorPrompt expands go.md with the task and the auto-pilot directive, minus frontmatter", () => {
  const prompt = buildConductorPrompt(REPO_ROOT, TASK);

  assert.ok(prompt.includes(TASK + AUTOPILOT_DIRECTIVE));
  assert.ok(!prompt.includes("$ARGUMENTS"));
  assert.ok(!prompt.startsWith("---"));
});

test("buildConductorPrompt tells an escalated run to write plain files under .agentry/work/", () => {
  const prompt = buildConductorPrompt(REPO_ROOT, TASK);

  assert.match(prompt, /\.agentry\/work\/<run>\//);
  for (const file of ["spec.md", "plan.md", "tasks/NNN-slug.md"])
    assert.ok(prompt.includes(file), file);
});

test("buildConductorPrompt names no flow MCP tool", () => {
  const prompt = buildConductorPrompt(REPO_ROOT, TASK);

  for (const tool of ["run_start", "event_emit", "artifact_write", "task_create", "backlog_claim"])
    assert.ok(!prompt.includes(tool), tool);
});

test("buildConductorPrompt falls back to a minimal conductor framing when go.md is absent", () => {
  const prompt = buildConductorPrompt(mkdtempSync(join(tmpdir(), "selfeval-no-plugin-")), TASK);

  assert.ok(prompt.startsWith("You are Agentry's conductor."));
  assert.ok(prompt.includes(TASK + AUTOPILOT_DIRECTIVE));
});
