// lanes — whether a repo has its lanes wired, for the `lanes` block of `board explain`. One row per
// lane: `{ lane, ok, value, set, optional? }`, where `set` is the one command that sets a missing lane. A
// missing lane is information, not an error; an optional workflow key that is absent (`optional`) shows
// `·`, not `✗`. The exec rows show each value as the preset resolves it, and where it comes from. Nothing is computed here that another reader already knows: the
// trigger block is `board instructions`' own comparison, the default agent is `board default-agent`'s
// static verify, the config is `lib/config.mjs`' strict reader.
//
// lanes({ root, spec, workflowPath }) -> [{ lane, ok, value, set }]   workflowPath: the workflow file in use
// renderLanes(rows, width) -> string[]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { relationWord, stampOf } from "../cli/init-vendor.mjs";
import { nextStep } from "../cli/invoke.mjs";
import { checkConfig } from "../config.mjs";
import { AGENT, PLUGIN_ROOT, localAgent, readSettings, verifyStatic } from "./default-agent.mjs";
import { isIgnored, trackedFiles, worktrees } from "./git.mjs";
import { LOCAL, TEMPLATE, localCaveat, locateBlock } from "./instruction-files.mjs";
import { renderBlock, upsertBlock } from "./instructions.mjs";
import { isKept } from "./keep.mjs";
import * as md from "./markdown.mjs";
import { readInside } from "./read.mjs";
import { columns } from "./render.mjs";
import { shownPath } from "./shown-path.mjs";
import { WORKFLOW_KEYS } from "./spec.mjs";
import { SPEC_VERSION } from "./spec/board.mjs";
import { sessionChecks, skillExists } from "./spec/extensions.mjs";
import { unusedUiModel } from "./spec/models.mjs";
import { flagField, resolveWorkflow } from "./spec/presets.mjs";
import { gateOf, runKinds } from "./spec/workflow.mjs";

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

function policy(root, [path, type, how]) {
  const tracked = trackedFiles(root, type === "dir" ? `${path}/**` : path);
  // A directory is probed through a child, so a `run/` pattern, which only matches a directory, applies.
  const state = tracked?.length
    ? "tracked"
    : isIgnored(root, type === "dir" ? `${path}/_` : path)
      ? "ignored"
      : "undecided";
  const set = how === "ignore" ? `echo ${path}/ >> .gitignore` : `git add ${path}`;
  return { lane: path, ok: state !== "undecided", value: state, set };
}

// The running npm package's version: the package's vendored copy (`vendor/`) carries no plugin
// manifest — the package manifest beside it is the running build's manifest instead (`cli/help`
// names it once; the name pins it so a parent repo's package.json stands in for nothing).
import { packageManifestVersion } from "../cli/help.mjs";

function pluginVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"))
      .version;
  } catch {
    // no plugin manifest beside the running CLI: a vendored copy — one inside the npm package reads
    // its own version from the package.json beside it, any other one from the stamp it was init'd
    // with; when neither exists, nobody knows.
    return packageManifestVersion() ?? stampOf(join(PLUGIN_ROOT, "..")) ?? "unknown";
  }
}

// The vendored CLI underneath (.agentry/bin), when `agentry init --vendor` copied one: a ✗ row when its
// stamp is behind the running plugin, silent when the stamp is absent, or current. The set line is the
// verb that refreshes the copy (and, with it, the payload it was generated for).
export function vendored(root) {
  const stamp = stampOf(root);
  if (stamp === null) return null;
  const current = pluginVersion();
  if (stamp === current) return null;
  const word = relationWord(current, stamp);
  return {
    lane: "vendored CLI",
    ok: false,
    value: `${stamp} (plugin: ${current}, ${word})`,
    set: "agentry init --host opencode --vendor --apply",
  };
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
// Where a resolved value comes from: the file sets it, or its preset does.
const sourceOf = (set, key) => (set.includes(key) ? "set" : "preset");
// The gate roles' source: `preset`, `set`, or the roles the file sets when it sets some.
function rolesSource(set) {
  const given = ["build", "verify", "merge"].filter((r) => set.includes(`gate.roles.${r}`));
  if (given.length === 0) return "preset";
  return given.length === 3 ? "set" : `${given.join(", ")} set`;
}

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
      `${Object.entries(roles)
        .map(([role, value]) => `${role} ${value}`)
        .join(" · ")} · ${rolesSource(resolveWorkflow(spec).set)}`,
    ],
    [
      "gate.checklist",
      checklist.length > 0 &&
        `${count(checklist.length, "item")}: ${checklist.map((i) => `${i.name} (${i.when ? whenText(i.when) : "every land"})`).join(", ")}`,
    ],
  ];
}

// The workflow file in use and its preset; none when there is no such file. The row carries
// `resolveWorkflow`'s object (`workflow`) and the keys the file sets (`keys`) for `--json`.
function workflowFile(root, spec, path) {
  const workflow = resolveWorkflow(spec);
  if (!existsSync(path))
    return { lane: "workflow", ok: false, value: `${workflow.preset} · none`, set: INIT, workflow };
  return {
    lane: "workflow",
    ok: true,
    value: `${workflow.preset} · ${shownPath(root, path)}`,
    set: INIT,
    workflow,
    keys: WORKFLOW_KEYS.filter((k) => Object.hasOwn(spec, k)),
  };
}

// The exec keys as the preset resolves them, each with its source; `exec.verify: "flagged"` says which field
// it keys on.
function execRows(spec) {
  const { exec, set } = resolveWorkflow(spec);
  const kinds = runKinds(spec);
  const names = kinds.length ? kinds : ["task"];
  const keyed = `keys on the ${names.join(" and ")} kind${names.length > 1 ? "s'" : "'s"} "${flagField(spec)}" field`;
  const row = (key, value) => ({
    lane: `exec.${key}`,
    ok: true,
    value: `${value} · ${sourceOf(set, `exec.${key}`)}`,
    set: INIT,
  });
  return [
    row("verify", exec.verify === "flagged" ? `flagged · ${keyed}` : exec.verify),
    // Read live by every running lane; the other exec keys are fixed at each lane's start.
    row("noteRounds", `${exec.noteRounds} (live)`),
    row("final", exec.final),
    row("rebase", exec.rebase),
  ];
}

// A model as the row shows it: its name, or one by path as its default and how many paths it has.
const modelText = (m) =>
  typeof m === "string" ? m : `${m.default} (${count(m.paths?.length ?? 0, "path")})`;

// `build sonnet · verify haiku, ui sonnet, flagged opus`: the model each exec dispatch names.
function modelsValue(models) {
  if (!models) return null;
  const verify = ["default", "ui", "flagged"]
    .filter((k) => models.verify?.[k])
    .map((k) => (k === "default" ? "" : `${k} `) + modelText(models.verify[k]));
  return (
    [
      models.build && `build ${modelText(models.build)}`,
      verify.length && `verify ${verify.join(", ")}`,
    ]
      .filter(Boolean)
      .join(" · ") || null
  );
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

// `extensions.<phase>.checks` as a row when set: the skills it names, ✗ when one has no SKILL.md here.
function sessionRow(root, spec, phase) {
  if (!spec.extensions?.[phase]) return null;
  const names = sessionChecks(spec, phase);
  const value = names.length ? `${count(names.length, "skill")}: ${names.join(", ")}` : "0 skills";
  return [`extensions.${phase}.checks`, value, names.every((n) => skillExists(root, n))];
}

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
    sessionRow(root, spec, "start"),
    sessionRow(root, spec, "close"),
  ];
  return rows.filter(Boolean).map(([lane, value, ok = true]) => ({ lane, ok, value, set: INIT }));
}

// The models row, with the warning for a verify model the route never uses.
function modelsRow(spec) {
  const value = modelsValue(spec.models);
  const unused = unusedUiModel(spec.models, resolveWorkflow(spec).exec.verify);
  return {
    lane: "models",
    ok: Boolean(value),
    value: value ?? "none",
    set: INIT,
    ...(!value && { optional: true }),
    ...(unused && { warning: unused }),
  };
}

export function lanes({ root, spec, workflowPath = join(root, ".agentry", "workflow.json") }) {
  const { extensions, conductor } = spec;
  const row = (lane, found, value, set = INIT) => ({
    lane,
    ok: Boolean(found),
    value: found ? value : "none",
    set,
  });
  // An optional workflow key: `·` when absent, never `✗`.
  const optional = (lane, found, value) => ({
    ...row(lane, found, value),
    ...(!found && { optional: true }),
  });
  const text = conductor?.prompt ? readInside(root, join(root, conductor.prompt)) : null;
  const rules = conductor?.rules && text !== null ? md.section(text, conductor.rules) : null;
  const checks = extensions?.merge?.checks;
  return [
    workflowFile(root, spec, workflowPath),
    ...execRows(spec),
    ...gateRows(spec).map(([lane, value]) => optional(lane, value, value)),
    modelsRow(spec),
    optional("conductor.prompt", conductor, conductor?.prompt),
    optional("conductor.rules", rules, `${conductor?.rules} (line ${rules?.line})`),
    { lane: "trigger block", ...triggerBlock(root, spec) },
    { lane: "default agent", ...defaultAgent(root) },
    { lane: "merge.push", ...push(root) },
    optional("merge.checks", checks, checks?.join(", ")),
    ...keys({ root, spec }),
    ...POLICY.map((entry) => policy(root, entry)),
    ...(vendored(root) ? [vendored(root)] : []),
    {
      lane: "process version",
      ok: spec.version === SPEC_VERSION,
      value: `${spec.version} · plugin ${pluginVersion()}`,
      set: INIT,
    },
  ];
}

// `text` in whole words on lines of at most `width` columns, the first after `lead`, the rest indented.
function wrapped(text, lead, width) {
  const lines = [lead];
  for (const word of text.split(" ")) {
    const line = lines.at(-1);
    if (line.trim() && line.length + 1 + word.length > width)
      lines.push(`${" ".repeat(lead.length + 2)}${word}`);
    else lines[lines.length - 1] = line.trim() ? `${line} ${word}` : `${line}${word}`;
  }
  return lines;
}

/** The rows as lines of at most `width` columns: `✓ lane  value`, `· lane  none` for an absent optional key,
 *  under a `✗` row an indented `set:` line with its command, and under a row with a warning its `!` line. */
export function renderLanes(rows, width) {
  const mark = (r) => (r.ok ? "✓" : r.optional ? "·" : "✗");
  const lines = columns(
    rows.map((r) => [mark(r), r.lane, r.value]),
    width,
  );
  return rows.flatMap((r, i) => [
    lines[i],
    ...(r.ok || r.optional ? [] : [`    set: ${nextStep(r.set)}`.slice(0, width)]),
    ...(r.warning ? wrapped(r.warning, "    ", width) : []),
  ]);
}
