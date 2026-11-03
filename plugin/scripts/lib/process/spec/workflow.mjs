// workflow — the workflow file (`.agentry/workflow.json`, optional): how the harness works this repo,
// one schema entry per key (mirrors core's `Workflow`, `packages/core/src/workflow.ts`), and the accessors
// that read a key with its default. An absent key is today's behaviour for it. Nothing here reads the
// board: every check that needs both files is `across.mjs`'s. PURE: never reads, never throws.
//
// The harness keys (`gate`, `extensions`, `conductor`, …): no empty string or list, no unknown key, paths
// inside the repository, skill names unique. Core's zod gives the same verdict on each (the shared table,
// `test/key-cases.mjs`).
import {
  FULL,
  distinct,
  filled,
  isObject,
  like,
  oneOf,
  own,
  posInt,
  record,
  repoPath,
  shape,
  str,
  text,
} from "./shape.mjs";

const lifecycle = shape({
  "kind!": str,
  "on!": shape({ dispatched: str, built: str, failed: str, merged: str }),
  write: shape({
    status: str,
    verdict: str,
    commit: str,
    handoff: like(/^parent\.file:.+$/, '"parent.file:<section>"'),
  }),
  handoff: str,
});
// The repo's gate (argv, no shell), its quick tier and the files it may leave changed; the repo
// skills merge runs as checks; the repo's conductor prompt (plan R1b §2, §3.1).
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
const gate = shape(
  {
    "command!": argv,
    quick: shape({ "command!": argv, "only!": globs }, FULL),
    after: globs,
    concurrency: posInt,
    flaky: filled(text),
    flakyLogs: filled(logGlob),
    note: text,
  },
  FULL,
);
const skill = like(/^[a-z0-9][a-z0-9-]*$/, "a skill name (lower-case letters, digits and -)");
// The exec lane's own settings: which items a verifier reads, and which model each dispatch names.
const VERIFY_ROUTES = ["all", "flagged", "none"];

/** The workflow file's checker; `workflowSchema.keys` (and each nested shape's `keys`) lists its keys.
 *  None is required. The format reference is bound to it. */
export const workflowSchema = shape({
  lifecycle,
  drafts: record(shape({ "kind!": str, "map!": record(str) })),
  worktrees: shape({ "keep!": filled(text) }, FULL),
  gate,
  extensions: shape({ "merge!": shape({ "checks!": distinct(skill) }, FULL) }, FULL),
  conductor: shape({ "prompt!": repoPath, rules: text }, FULL),
  guard: shape({ "allow!": globs }, FULL),
  cleanup: shape({ "disposable!": globs }, FULL),
  exec: shape({ verify: oneOf(...VERIFY_ROUTES) }, FULL),
  models: shape(
    { build: text, verify: shape({ default: text, ui: text, flagged: text }, FULL) },
    FULL,
  ),
});

/** Check a parsed workflow file: each problem goes to `bad(path, message)`. */
export function validateWorkflow(value, bad) {
  workflowSchema(value, "", (at, message) => bad(at || "the workflow file", message));
}

/** Which items the exec lane sends to a verifier: "all" (default), "flagged" or "none". */
export const verifyRoute = (spec) => own(own(spec, "exec"), "verify") ?? "all";

/** The field name `exec.verify: "flagged"` reads from the lifecycle kind (`task` when there is none). */
export const FLAG_FIELD = "flag";

/** Is item `id` of the exec kind flagged on the board `model`: its `flag` field is set (and is a flag
 *  field). False when the kind has no such field or the item is not on the board. */
export function flaggedItem(spec, model, id) {
  const name = typeof spec?.lifecycle?.kind === "string" ? spec.lifecycle.kind : "task";
  if (own(own(own(spec?.kinds, name), "fields"), FLAG_FIELD)?.type !== "flag") return false;
  const item = own(model?.kinds, name)?.items?.find((i) => i.id === id);
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

/** The repo's gate with its defaults filled (`after: []`, `concurrency: 1`, `flaky: []`, `flakyLogs: []`,
 *  no quick tier), or null when the workflow file has none. A copy: changing it never changes the spec. */
export function gateOf(spec) {
  const g = own(spec, "gate");
  if (!isObject(g)) return null;
  return structuredClone({
    command: g.command,
    quick: g.quick ?? null,
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
