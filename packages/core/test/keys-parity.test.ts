// The harness keys hold one verdict in both validators (plan R1b §2.1): every case of the shared table
// (`plugin/scripts/test/key-cases.mjs`) goes through core's zod and the plugin's dependency-free
// validator (`spec.mjs` for process.json and workflow.json, against `ProcessBoard` plus `Workflow`;
// `lib/config.mjs` for config.json), which must accept the same cases and name the same paths.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ZodError } from "zod";
import { checkConfig } from "../../../plugin/scripts/lib/config.mjs";
import { validateSpec } from "../../../plugin/scripts/lib/process/spec.mjs";
import {
  CONFIG_CASES,
  PROCESS_CASES,
  configOf,
  pathOf,
  specOf,
} from "../../../plugin/scripts/test/key-cases.mjs";
import { AgentryConfig } from "../src/config.js";
import { ProcessBoard } from "../src/process.js";
import { Workflow } from "../src/workflow.js";

interface Case {
  name: string;
  bad?: string[];
}

const dotted = (path: (string | number)[]) =>
  path.reduce<string>(
    (at, k) => (typeof k === "number" ? `${at}[${k}]` : at ? `${at}.${k}` : k),
    "",
  );

// The paths a zod error names, an unknown key named by its own path as the plugin names it.
function zodPaths(error: ZodError | undefined): string[] {
  return (error?.issues ?? []).flatMap((issue) =>
    issue.code === "unrecognized_keys"
      ? issue.keys.map((k) => dotted([...issue.path, k]))
      : [dotted(issue.path)],
  );
}
const sorted = (paths: string[]) => [...new Set(paths)].sort();

function agree(c: Case, plugin: string[], zod: string[]) {
  assert.deepEqual(sorted(zod), sorted(plugin), `${c.name}: zod and the plugin name other paths`);
  assert.deepEqual(sorted(plugin), sorted(c.bad ?? []), `${c.name}: not the table's verdict`);
}

test("the shared table is large enough and has both verdicts (plan R1b §2.1: ≥ 40 cases)", () => {
  const all: Case[] = [...PROCESS_CASES, ...CONFIG_CASES];
  assert.ok(all.length >= 40, `${all.length} cases`);
  assert.ok(all.some((c) => c.bad) && all.some((c) => !c.bad));
});

test("process.json and workflow.json keys: zod and spec.mjs give the same verdict on every case", () => {
  for (const c of PROCESS_CASES as Case[]) {
    const { board, workflow } = specOf(c);
    const plugin = validateSpec({ board, workflow }).problems.map((p: { message: string }) =>
      pathOf(p.message),
    );
    const zod = [
      ...zodPaths(ProcessBoard.safeParse(board).error),
      ...(workflow === undefined ? [] : zodPaths(Workflow.safeParse(workflow).error)),
    ];
    agree(c, plugin, zod);
  }
});

test("config.json merge and lanes: zod and config.mjs give the same verdict on every case", () => {
  for (const c of CONFIG_CASES as Case[]) {
    const value = configOf(c);
    agree(c, checkConfig(value).map(pathOf), zodPaths(AgentryConfig.safeParse(value).error));
  }
});

test("the config defaults agree: push ask, three writers", () => {
  const parsed = AgentryConfig.parse({});
  assert.deepEqual(parsed.merge, { push: "ask" });
  assert.deepEqual(parsed.lanes, { maxWriters: 3 });
});

test("the keys 0.3 replaced point to gate.tiers in zod, as in the plugin", () => {
  const old = { gate: { tiers: [{ name: "full", command: ["x"] }], command: ["x"], quick: {} } };
  const issues = Workflow.safeParse(old).error?.issues ?? [];
  const at = (key: string) => issues.find((i) => dotted(i.path) === `gate.${key}`)?.message ?? "";
  assert.match(at("command"), /^replaced by gate\.tiers \(0\.3\): make it the last tier/);
  assert.match(at("quick"), /^replaced by gate\.tiers: a tier with "when": \{ "only"/);
});
