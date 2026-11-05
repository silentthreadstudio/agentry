// models — the workflow file's `models` key (mirrors core's `Models`) and the model each exec dispatch
// names, with where it came from (field 73): for a builder the run's step marker (field 96), then a
// contract bullet, then a path entry, then the key itself. And the model a route never uses (field 70).
// PURE: never reads, never throws.
//
//   modelsSchema                                            the `models` checker (workflowSchema's entry)
//   modelFor(spec, role, { flagged, ui, owned, contract, steps, stepRun }) -> { model, from } | null
//   bulletOf(block, label) -> string | null                 `- **<label>:** <word>`'s word, outside fences
//   proseModelHint(block, steps) -> string | null           a model named only in prose, as `exec start`'s line
//   unusedUiModel(models, verify) -> string | null          the `! models.verify.ui is unused: …` line
import { globMatch } from "../../lane/gate.mjs";
import { unfenced } from "../markdown.mjs";
import { runMark } from "../steps.mjs";
import { FULL, filled, isObject, own, repoPath, shape, text } from "./shape.mjs";

// A model: its name, or `{ default, paths }` where the first entry whose `when.any` glob matches an owned
// file names it (the gate tiers' `globMatch`), else `default`.
const byPath = shape(
  {
    "default!": text,
    "paths!": filled(
      shape({ "when!": shape({ "any!": filled(repoPath) }, FULL), "model!": text }, FULL),
    ),
  },
  FULL,
);
const model = (v, at, bad) => (typeof v === "string" ? text : byPath)(v, at, bad);

/** The `models` checker: `build` and each `verify` key a model (a name, or by path). */
export const modelsSchema = shape(
  { build: model, verify: shape({ default: model, ui: model, flagged: model }, FULL) },
  FULL,
);

// `value` (a `models` key at `path`) resolved for the owned files: `{ model, from }`, or null when unset.
function resolve(value, path, owned) {
  if (typeof value === "string") return { model: value, from: path };
  if (!isObject(value)) return null;
  for (const [i, entry] of (value.paths ?? []).entries()) {
    const glob = entry.when?.any?.find((g) => owned.some((file) => globMatch([g], file)));
    if (glob !== undefined) return { model: entry.model, from: `${path}.paths[${i}]: ${glob}` };
  }
  return { model: value.default, from: `${path}.default` };
}

// The contract read outside its code fences (`unfenced`): a bullet shown in a fence is an example, not
// the contract's.

/** The first word of the contract's `- **<label>:** <word>` bullet outside a code fence, backticks
 *  dropped; `label` is a regexp source matched in any case. Null when the contract has none. */
export function bulletOf(block, label) {
  const re = new RegExp(String.raw`^[ \t]*(?:[-*+][ \t]+)?\*\*${label}:?\*\*:?[ \t]*(\S+)`, "im");
  return re.exec(unfenced(String(block ?? "")))?.[1].replace(/`/g, "") || null;
}

// The contract's own model for `role`: for a builder the first step of its run (`stepRun`) naming one,
// then `- **Model:** <model>`; for a verifier `**Model (verify):** <model>` (a step marker names a builder).
const LABEL = { build: "model", verify: String.raw`model \(verify\)` };
function contractModel(block, role, { steps, stepRun } = {}) {
  const step = role === "build" && runMark(steps, stepRun, "model");
  if (step) return { model: step.value, from: step.from };
  const word = bulletOf(block, LABEL[role]);
  return word ? { model: word, from: "contract" } : null;
}

// A model word the prose names near "model" or a role word: within this many words of it.
const MODEL_WORDS = new Set(["opus", "sonnet", "haiku", "fable"]);
const NEAR_WORDS = new Set([
  "model",
  "models",
  "build",
  "builder",
  "builds",
  "verify",
  "verifier",
  "implementer",
  "designer",
]);
const NEAR = 6;
// A token that reads as a path or a file name: a slash, or a dot between word characters.
const PATHY = /\/|\w\.\w/;

/** `exec start`'s hint when no step marker and no `**Model…**` bullet names a model but the contract's prose
 *  (outside code fences, code spans and paths) names one of the known model words near "model" or a role
 *  word; null otherwise. */
export function proseModelHint(block, steps = []) {
  if (steps.some((s) => s.model) || bulletOf(block, String.raw`model(?: \(verify\))?`)) return null;
  // Prose only: code spans and path-like tokens (`src/opus/model.ts`, `model.ts`) name no model.
  // Each whitespace-split token is tested on its own, so a long token costs linear time.
  const words = unfenced(String(block ?? ""))
    .replace(/`[^`]*`/g, " ")
    .split(/\s+/)
    .filter((token) => !PATHY.test(token))
    .join(" ")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  const near = (i) =>
    words.slice(Math.max(0, i - NEAR), i + NEAR + 1).some((w) => NEAR_WORDS.has(w));
  const word = words.find((w, i) => MODEL_WORDS.has(w) && near(i));
  return word
    ? `the contract mentions ${word} in prose: add - **Model:** ${word} (or a step marker) to make it the dispatch`
    : null;
}

/** The model a dispatch of `role` ("build" or "verify") names, and where it came from: for a builder
 *  the first step of its run (`stepRun` of `steps`) with a model marker (`step N`), then the contract's
 *  bullet, else for a builder `models.build`, for a verifier `models.verify.flagged` when the item is
 *  flagged, `.ui` when a designer builds it, else `.default`; a key by path takes its first entry matching
 *  an owned file, else its default. Null when nothing names one. */
export function modelFor(
  spec,
  role,
  { flagged = false, ui = false, owned = [], contract = "", steps = [], stepRun = null } = {},
) {
  const named = contractModel(contract, role, { steps, stepRun });
  if (named) return named;
  const models = own(spec, "models");
  if (role === "build") return resolve(own(models, "build"), "models.build", owned);
  const verify = own(models, "verify");
  const keys = [flagged && "flagged", ui && "ui", "default"].filter(Boolean);
  for (const key of keys) {
    const found = resolve(own(verify, key), `models.verify.${key}`, owned);
    if (found) return found;
  }
  return null;
}

/** Under a route that verifies an item only when it is flagged (`exec.verify` "flagged" or "none"), a
 *  UI task unflagged gets no verifier, and a flagged one takes `models.verify.flagged` when it is set: a
 *  `models.verify.ui` set beside it is never used. The line saying so; null when the ui model can be used. */
export function unusedUiModel(models, verify) {
  const keys = own(models, "verify");
  if (own(keys, "ui") === undefined || own(keys, "flagged") === undefined) return null;
  if (!["flagged", "none"].includes(verify)) return null;
  return `! models.verify.ui is unused: exec.verify is ${verify} and a UI task is verified only when flagged`;
}
