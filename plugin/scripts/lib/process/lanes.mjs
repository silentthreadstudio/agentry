// lanes — whether a repo has its lanes wired, for the `lanes` block of `board explain`. One row per
// lane: `{ lane, ok, value, set }`, where `set` is the one command that sets a missing lane. A missing
// lane is information, not an error. Nothing is computed here that another reader already knows: the
// trigger block is `board instructions`' own comparison, the default agent is `board default-agent`'s
// static verify, the config is `lib/config.mjs`' strict reader.
//
// lanes({ root, spec, workflowPath }) -> [{ lane, ok, value, set }]   workflowPath: the workflow file in use
// renderLanes(rows, width) -> string[]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { nextStep } from "../cli/invoke.mjs";
import { checkConfig } from "../config.mjs";
import { AGENT, PLUGIN_ROOT, localAgent, readSettings, verifyStatic } from "./default-agent.mjs";
import { trackedFiles, worktrees } from "./git.mjs";
import { LOCAL, TEMPLATE, localCaveat, locateBlock } from "./instruction-files.mjs";
import { renderBlock, upsertBlock } from "./instructions.mjs";
import { isKept } from "./keep.mjs";
import * as md from "./markdown.mjs";
import { readInside } from "./read.mjs";
import { columns } from "./render.mjs";
import { WORKFLOW_KEYS } from "./spec.mjs";
import { SPEC_VERSION } from "./spec/board.mjs";
import { gateOf } from "./spec/workflow.mjs";

const INIT = "/agentry:init";
// What `.agentry/` holds, and the command that decides each when it is neither tracked nor ignored.
const POLICY = [
  [".agentry/process.json", "file"],
  [".agentry/workflow.json", "file"],
  [".agentry/config.json", "file"],
  [".agentry/NOTE.md", "file"],
  [".agentry/memory", "dir"],
  [".agentry/run", "dir", "ignore"],
  [".agentry/work", "dir", "ignore"],
];

function ignored(root, path) {
  try {
    execFileSync("git", ["-C", root, "check-ignore", "-q", "--", path], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function policy(root, [path, type, how]) {
  const tracked = trackedFiles(root, type === "dir" ? `${path}/**` : path);
  // A directory is probed through a child, so a `run/` pattern, which only matches a directory, applies.
  const state = tracked?.length
    ? "tracked"
    : ignored(root, type === "dir" ? `${path}/_` : path)
      ? "ignored"
      : "undecided";
  const set = how === "ignore" ? `echo ${path}/ >> .gitignore` : `git add ${path}`;
  return { lane: path, ok: state !== "undecided", value: state, set };
}

function pluginVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"))
      .version;
  } catch {
    return "unknown";
  }
}

// The trigger block, in AGENTS.md or CLAUDE.local.md, against the one `board instructions` would write.
// A block in CLAUDE.local.md that git tracks or does not ignore would reach the repo's history.
function triggerBlock(root, spec) {
  const set = "board instructions --apply";
  const found = locateBlock(root);
  if (found.error) return { ok: false, value: found.error, set };
  const name = found.at ?? "AGENTS.md";
  const block = renderBlock(readFileSync(TEMPLATE, "utf8"), { prompt: spec.conductor?.prompt });
  const up = upsertBlock(found.files[name].text, block);
  if (up.error) return { ok: false, value: up.error, set };
  const value = { create: "no AGENTS.md", append: "no block", replace: "out of date" }[up.action];
  if (up.action !== "unchanged") return { ok: false, value, set };
  if (name === LOCAL && localCaveat(root))
    return {
      ok: false,
      value: `${name} block is current, but git does not ignore it`,
      set: `echo ${LOCAL} >> .gitignore`,
    };
  return { ok: true, value: `${name} block is current`, set };
}

function defaultAgent(root) {
  const set = "board default-agent --apply";
  const read = readSettings(root);
  if (read.error) return { ok: false, value: read.error, set };
  const local = localAgent(root);
  if (local !== undefined && local !== AGENT)
    return { ok: false, value: "overridden by settings.local.json", set };
  const verdict = verifyStatic(read.data.agent);
  return { ok: verdict.resolved === "yes", value: read.data.agent ?? "unset", set };
}

// `merge.push` as the project's config file sets it; the effective default ("ask") is not a choice made.
function push(root) {
  const set = "/agentry:config merge.push=<ask|auto|never>";
  const file = join(root, ".agentry", "config.json");
  if (!existsSync(file)) return { ok: false, value: "unset (asks each time)", set };
  let config;
  try {
    config = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ok: false, value: "config.json is not valid JSON", set };
  }
  const [problem] = checkConfig(config);
  if (problem) return { ok: false, value: problem, set };
  const value = config.merge?.push;
  return value === undefined
    ? { ok: false, value: "unset (asks each time)", set }
    : { ok: true, value, set };
}

const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

// A tier's or checklist item's `when` in a few words: `only 2 globs, or flagged`.
const whenText = (when) =>
  [
    when.only && `only ${count(when.only.length, "glob")}`,
    when.any && `any ${count(when.any.length, "glob")}`,
    when.flag && "flagged",
  ]
    .filter(Boolean)
    .join(", or ");
// The gate's rows: its tiers in order, the tier each role runs, and its checklist (none when it has none).
function gateRows(spec) {
  const gate = gateOf(spec);
  if (!gate)
    return [
      ["gate.tiers", null],
      ["gate.checklist", null],
    ];
  const { tiers, roles, checklist } = gate;
  return [
    [
      "gate.tiers",
      tiers.map((t) => (t.when ? `${t.name} (${whenText(t.when)})` : t.name)).join(" → "),
    ],
    [
      "gate.roles",
      Object.entries(roles)
        .map(([role, value]) => `${role} ${value}`)
        .join(" · "),
    ],
    [
      "gate.checklist",
      checklist.length > 0 &&
        `${count(checklist.length, "item")}: ${checklist.map((i) => `${i.name} (${i.when ? whenText(i.when) : "every land"})`).join(", ")}`,
    ],
  ];
}

/** A path as the output shows it: from `root` when it is inside, else as given. */
export const shownPath = (root, path) =>
  relative(root, path).startsWith("..") ? path : relative(root, path);

// The workflow file in use and how many keys it sets; none when there is no such file.
function workflowFile(root, spec, path) {
  if (!existsSync(path)) return { lane: "workflow file", ok: false, value: "none", set: INIT };
  const n = WORKFLOW_KEYS.filter((k) => Object.hasOwn(spec, k)).length;
  return {
    lane: "workflow file",
    ok: true,
    value: `${shownPath(root, path)} · ${count(n, "key")}`,
    set: INIT,
  };
}

// `build 2 lines · verify 1 line`: the roles that set policy lines, with how many.
const briefsValue = (briefs) =>
  ["build", "verify"]
    .filter((role) => briefs[role])
    .map((role) => `${role} ${count(briefs[role].length, "line")}`)
    .join(" · ") || "no lines";
// `subject ≤ 72 · pattern · 1 forbid`: each commit rule that is set.
const commitsValue = ({ subjectMax, subjectPattern, forbid }) =>
  [
    subjectMax !== undefined && `subject ≤ ${subjectMax}`,
    subjectPattern !== undefined && "pattern",
    forbid && `${forbid.length} forbid`,
  ]
    .filter(Boolean)
    .join(" · ") || "no rules";

// The newer keys, one row each when set (an unset one is no lane to wire, so no row), each with what it
// matches here (the count first, so a long glob list cuts the globs, not the count): the kept worktrees, the tracked files a guard glob lets through, the flaky names.
function keys({ root, spec }) {
  const { worktrees: wt, guard, cleanup, gate, briefs, commits } = spec;
  const allowed = guard?.allow.flatMap((glob) => trackedFiles(root, glob) ?? []);
  const rows = [
    wt?.keep && [
      "worktrees.keep",
      `${count(worktrees(root).filter((t) => isKept(spec, t)).length, "worktree")}: ${wt.keep.join(", ")}`,
    ],
    guard && [
      "guard.allow",
      `${count(new Set(allowed).size, "tracked file")}: ${guard.allow.join(", ")}`,
    ],
    cleanup && ["cleanup.disposable", cleanup.disposable.join(", ")],
    gate?.flaky && ["gate.flaky", count(gate.flaky.length, "name")],
    gate?.concurrency !== undefined && ["gate.concurrency", count(gate.concurrency, "slot")],
    briefs && ["briefs", briefsValue(briefs)],
    commits && ["commits", commitsValue(commits)],
  ];
  return rows.filter(Boolean).map(([lane, value]) => ({ lane, ok: true, value, set: INIT }));
}

export function lanes({ root, spec, workflowPath = join(root, ".agentry", "workflow.json") }) {
  const { extensions, conductor } = spec;
  const row = (lane, found, value, set = INIT) => ({
    lane,
    ok: Boolean(found),
    value: found ? value : "none",
    set,
  });
  const text = conductor?.prompt ? readInside(root, join(root, conductor.prompt)) : null;
  const rules = conductor?.rules && text !== null ? md.section(text, conductor.rules) : null;
  const checks = extensions?.merge?.checks;
  return [
    workflowFile(root, spec, workflowPath),
    ...gateRows(spec).map(([lane, value]) => row(lane, value, value)),
    row("conductor.prompt", conductor, conductor?.prompt),
    row("conductor.rules", rules, `${conductor?.rules} (line ${rules?.line})`),
    { lane: "trigger block", ...triggerBlock(root, spec) },
    { lane: "default agent", ...defaultAgent(root) },
    { lane: "merge.push", ...push(root) },
    row("merge.checks", checks, checks?.join(", ")),
    ...keys({ root, spec }),
    ...POLICY.map((entry) => policy(root, entry)),
    {
      lane: "process version",
      ok: spec.version === SPEC_VERSION,
      value: `${spec.version} · plugin ${pluginVersion()}`,
      set: INIT,
    },
  ];
}

/** The rows as lines of at most `width` columns: `✓ lane  value`, and under a `✗` row an indented
 *  `set:` line with its command. */
export function renderLanes(rows, width) {
  const lines = columns(
    rows.map((r) => [r.ok ? "✓" : "✗", r.lane, r.value]),
    width,
  );
  return rows.flatMap((r, i) => [
    lines[i],
    ...(r.ok ? [] : [`    set: ${nextStep(r.set)}`.slice(0, width)]),
  ]);
}
