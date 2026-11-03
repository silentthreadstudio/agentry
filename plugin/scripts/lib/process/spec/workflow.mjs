// workflow — the workflow file (`.agentry/workflow.json`, optional): how the harness works this repo,
// one schema entry per key (mirrors core's `Workflow`, `packages/core/src/workflow.ts`), and the accessors
// that read a key with its default. An absent key is today's behaviour for it. Nothing here reads the
// board: every check that needs both files is `across.mjs`'s. PURE: never reads, never throws.
//
// The harness keys (`gate`, `extensions`, `conductor`, …): no empty string or list, no unknown key, paths
// inside the repository, skill names unique. Core's zod gives the same verdict on each (the shared table,
// `test/key-cases.mjs`).
import { extensions } from "./extensions.mjs";
import {
  FULL,
  filled,
  has,
  is,
  isObject,
  join,
  like,
  namesOf,
  oneOf,
  own,
  posInt,
  quote,
  record,
  regex,
  repoPath,
  shape,
  str,
  text,
} from "./shape.mjs";

const on = shape({ dispatched: str, built: str, failed: str, merged: str });
const writes = { status: str, verdict: str, commit: str };
const lifecycle = shape({
  "kind!": str,
  "on!": on,
  write: shape({
    ...writes,
    handoff: like(/^parent\.file:.+$/, '"parent.file:<section>"'),
  }),
  handoff: str,
});
/** One `exec.kinds` entry: the lifecycle mapping of a kind exec runs beside the lifecycle's. The key
 *  names the kind, and it writes no handoff. The format reference's "exec kinds" table is bound to it. */
export const execKindSchema = shape({ "on!": on, write: shape(writes) }, FULL);
// The repo's gate: its tiers (argv, no shell, each but the last with a `when`), the tier each role runs,
// a manual checklist and the files it may leave changed; the repo skills merge runs as checks; the
// repo's conductor prompt (plan R1b §2, §3.1).
const argv = filled(text);
const globs = filled(repoPath);
// A log glob for `gate.flakyLogs`: from the gate's cwd, or from the temp directory when it starts `$TMPDIR/`.
// Absolute paths and any `..` segment are refused.
const logGlob = (v, at, bad) => {
  if (typeof v !== "string" || v.length === 0) return text(v, at, bad);
  const rest = v.startsWith("$TMPDIR/") ? v.slice("$TMPDIR/".length) : v;
  if (rest === "" || rest.startsWith("/") || rest.split("/").some((x) => x === ".." || x === "."))
    bad(at, `"${v}" is not a glob from the gate's cwd or $TMPDIR/`);
};
const name = like(/^[a-z0-9][a-z0-9-]*$/, "a name (lower-case letters, digits and -)");
// `pick` and `none` are what a role says instead of a tier, so no tier is called that.
const ROLE_WORDS = ["pick", "none"];
const tierName = (v, at, bad) => {
  name(v, at, bad);
  if (ROLE_WORDS.includes(v)) bad(at, `cannot be "${v}": that is a gate.roles value`);
};
// When a tier (or a checklist item) applies: any one of its conditions holding is enough.
const whenKeys = shape(
  {
    only: globs,
    any: globs,
    flag: is((v) => v === true, "takes only true (leave it out instead)"),
  },
  FULL,
);
const when = Object.assign(
  (v, at, bad) => {
    whenKeys(v, at, bad);
    if (isObject(v) && !namesOf(whenKeys.keys).some((k) => has(v, k)))
      bad(at, 'should hold "only", "any" or "flag"');
  },
  { keys: whenKeys.keys },
);
// A non-empty list of shapes with unique `name`s; `more` checks each item against the list. The item's
// shape rides along (`item`) for the format reference.
const named = (item, more = () => {}) =>
  Object.assign(
    (v, at, bad) => {
      filled(item)(v, at, bad);
      if (!Array.isArray(v)) return;
      v.forEach((x, i) => {
        const n = own(x, "name");
        if (typeof n === "string" && v.findIndex((y) => own(y, "name") === n) < i)
          bad(`${at}[${i}].name`, `repeats "${n}"`);
        if (isObject(x)) more(x, i === v.length - 1, `${at}[${i}]`, bad);
      });
    },
    { item },
  );
// The tiers in precedence order: the last is the fallback, so it alone has no `when`.
const tiers = named(
  shape({ "name!": tierName, "command!": argv, when }, FULL),
  (t, last, at, bad) => {
    if (t.name === "full" && !last) bad(`${at}.name`, '"full" names the last tier only');
    if (last && has(t, "when"))
      bad(`${at}.when`, "the last tier is the fallback: it takes no when");
    if (!last && !has(t, "when")) bad(`${at}.when`, "is required on every tier but the last");
  },
);
const checklist = named(shape({ "name!": name, "text!": text, when }, FULL));
// What each role may name besides a tier.
const ROLES = {
  build: ["pick", "full"],
  verify: ["pick", "full", "none"],
  merge: ["pick", "full"],
};
const roles = shape({ build: str, verify: str, merge: str }, FULL);
// The keys 0.3 replaced, refused with where their value goes now.
const REPLACED = new Map([
  [
    "command",
    'replaced by gate.tiers (0.3): make it the last tier, { "name": "full", "command": […] }',
  ],
  ["quick", 'replaced by gate.tiers: a tier with "when": { "only": […] } before the last'],
]);
const gateKeys = shape(
  {
    "tiers!": tiers,
    roles,
    checklist,
    after: globs,
    concurrency: posInt,
    flaky: filled(text),
    flakyLogs: filled(logGlob),
    note: text,
  },
  FULL,
);
const gate = Object.assign(
  (v, at, bad) => {
    if (!isObject(v)) return gateKeys(v, at, bad);
    for (const [key, message] of REPLACED) if (has(v, key)) bad(join(at, key), message);
    gateKeys(Object.fromEntries(Object.entries(v).filter(([k]) => !REPLACED.has(k))), at, bad);
    const names = Array.isArray(v.tiers)
      ? v.tiers.map((t) => own(t, "name")).filter((n) => typeof n === "string")
      : [];
    for (const [role, words] of Object.entries(ROLES)) {
      const value = own(own(v, "roles"), role);
      if (typeof value === "string" && !words.includes(value) && !names.includes(value))
        bad(
          join(at, `roles.${role}`),
          `names no tier ("${value}"): the tiers are ${quote(names)}; or say ${words.join(", ")}`,
        );
    }
  },
  { keys: gateKeys.keys },
);
// The exec lane's own settings: which items a verifier reads, and which model each dispatch names.
const VERIFY_ROUTES = ["all", "flagged", "none"];
// The repo's policy lines for a brief (one line each, at most BRIEF_LINES) and its commit rules.
const BRIEF_LINES = 20;
const policyLine = (v, at, bad) => {
  text(v, at, bad);
  if (typeof v === "string" && /[\r\n]/.test(v)) bad(at, "should be one line");
};
const policyLines = (v, at, bad) => {
  filled(policyLine)(v, at, bad);
  if (Array.isArray(v) && v.length > BRIEF_LINES)
    bad(at, `should have at most ${BRIEF_LINES} lines`);
};
const pattern = (v, at, bad) => {
  text(v, at, bad);
  if (typeof v === "string" && v) regex(v, at, bad);
};

// Named locks (`agentry run --lock`, `agentry lock take`): `{ "<name>": <slots, at least 1> }`, one entry or more.
const locks = (v, at, bad) => {
  record(posInt)(v, at, bad);
  if (!isObject(v)) return;
  if (Object.keys(v).length === 0) bad(at, "should not be empty");
  for (const k of Object.keys(v)) if (k !== "__proto__") name(k, join(at, k), bad);
};

/** The workflow file's checker; `workflowSchema.keys` (and each nested shape's `keys`) lists its keys.
 *  None is required. The format reference is bound to it. */
export const workflowSchema = shape({
  lifecycle,
  drafts: record(shape({ "kind!": str, "map!": record(str) })),
  worktrees: shape({ "keep!": filled(text) }, FULL),
  gate,
  extensions,
  conductor: shape({ "prompt!": repoPath, rules: text }, FULL),
  guard: shape({ "allow!": globs }, FULL),
  cleanup: shape({ "disposable!": globs }, FULL),
  exec: shape({ verify: oneOf(...VERIFY_ROUTES), kinds: record(execKindSchema) }, FULL),
  models: shape(
    { build: text, verify: shape({ default: text, ui: text, flagged: text }, FULL) },
    FULL,
  ),
  briefs: shape({ build: policyLines, verify: policyLines }, FULL),
  commits: shape({ subjectMax: posInt, subjectPattern: pattern, forbid: filled(pattern) }, FULL),
  locks,
});

/** Check a parsed workflow file: each problem goes to `bad(path, message)`. One `lane merge --check
 *  <name>` records a checklist item or a merge check, so no name is both. */
export function validateWorkflow(value, bad) {
  workflowSchema(value, "", (at, message) => bad(at || "the workflow file", message));
  const items = own(own(value, "gate"), "checklist");
  const checks = own(own(own(value, "extensions"), "merge"), "checks");
  if (!Array.isArray(items) || !Array.isArray(checks)) return;
  items.forEach((item, i) => {
    const n = own(item, "name");
    if (typeof n === "string" && checks.includes(n))
      bad(`gate.checklist[${i}].name`, `"${n}" is also an extensions.merge.checks name`);
  });
}

/** Which items the exec lane sends to a verifier: "all" (default), "flagged" or "none". */
export const verifyRoute = (spec) => own(own(spec, "exec"), "verify") ?? "all";

/** The field name `exec.verify: "flagged"` reads from each kind exec runs (`task` when there is none). */
export const FLAG_FIELD = "flag";

const lifeKind = (spec) => {
  const kind = own(own(spec, "lifecycle"), "kind");
  return typeof kind === "string" ? kind : null;
};
const execKinds = (spec) => {
  const kinds = own(own(spec, "exec"), "kinds");
  return isObject(kinds) ? kinds : {};
};

/** The kinds exec and merge run: the lifecycle's, then each `exec.kinds` key. `[]` with no lifecycle. */
export function runKinds(spec) {
  const life = lifeKind(spec);
  return life ? [life, ...Object.keys(execKinds(spec)).filter((k) => k !== life)] : [];
}

/** How exec writes items of `kind`: `{ kind, on, write, handoff? }`, the lifecycle itself for its kind,
 *  an `exec.kinds` entry (no handoff) for another runnable kind; null for a kind exec does not run. */
export function lifecycleOf(spec, kind) {
  const life = lifeKind(spec);
  if (!life || typeof kind !== "string") return null;
  const def = kind === life ? spec.lifecycle : own(execKinds(spec), kind);
  if (!isObject(def)) return null;
  const write = isObject(def.write) ? def.write : {};
  const handoff = kind === life && Object.hasOwn(def, "handoff") ? { handoff: def.handoff } : {};
  return { kind, on: isObject(def.on) ? def.on : {}, write, ...handoff };
}

/** Is item `id` of `kind` (the lifecycle's by default) flagged on the board `model`: its `flag` field is
 *  set (and is a flag field). False when the kind has no such field or the item is not on the board. */
export function flaggedItem(spec, model, id, kind = lifeKind(spec) ?? "task") {
  if (own(own(own(spec?.kinds, kind), "fields"), FLAG_FIELD)?.type !== "flag") return false;
  const item = own(model?.kinds, kind)?.items?.find((i) => i.id === id);
  return Boolean(own(item?.fields, FLAG_FIELD));
}

/** The model a dispatch names, or null: `role` "build", or "verify" with the item's `flagged` and `ui`
 *  facts (flagged first, then ui, then the verify default). Null when the workflow file names none. */
export function modelFor(spec, role, { flagged = false, ui = false } = {}) {
  const models = own(spec, "models");
  if (role === "build") return own(models, "build") ?? null;
  const verify = own(models, "verify");
  return (
    (flagged && own(verify, "flagged")) ||
    (ui && own(verify, "ui")) ||
    own(verify, "default") ||
    null
  );
}

// The tier each role runs when `gate.roles` does not say.
const ROLE_DEFAULTS = { build: "pick", verify: "none", merge: "pick" };

/** The repo's gate with its defaults filled (`roles` build pick, verify none, merge pick; `checklist: []`,
 *  `after: []`, `concurrency: 1`, `flaky: []`, `flakyLogs: []`), or null when the workflow file has none.
 *  A copy: changing it never changes the spec. */
export function gateOf(spec) {
  const g = own(spec, "gate");
  if (!isObject(g)) return null;
  return structuredClone({
    tiers: g.tiers,
    roles: { ...ROLE_DEFAULTS, ...g.roles },
    checklist: g.checklist ?? [],
    after: g.after ?? [],
    concurrency: g.concurrency ?? 1,
    flaky: g.flaky ?? [],
    flakyLogs: g.flakyLogs ?? [],
    note: g.note ?? null,
  });
}

/** The values a handoff template fills: `{id}`, `{sha}` (the first commit) and `{summary}`. */
export const SLOTS = ["id", "sha", "summary"];
export const SLOT = /\{(\w+)\}/g;
/** A handoff template filled: each value on one line (runs of white space become one space); any
 *  other `{name}` is left as written (the load check refuses it). `lifecycle.mjs`'s `renderHandoff`
 *  is this on the spec's template. */
export const fillHandoff = (template, values) =>
  template.replace(SLOT, (all, name) =>
    SLOTS.includes(name)
      ? String(own(values, name) ?? "")
          .replace(/\s+/g, " ")
          .trim()
      : all,
  );
