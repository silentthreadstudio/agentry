// models — the workflow file's `models` key (mirrors core's `Models`) and the model each exec dispatch
// names, with where it came from (field 73): a contract bullet, then a path entry, then the key itself. And
// the model a route never uses (field 70). PURE: never reads, never throws.
//
//   modelsSchema                                            the `models` checker (workflowSchema's entry)
//   modelFor(spec, role, { flagged, ui, owned, contract }) -> { model, from } | null
//   unusedUiModel(models, verify) -> string | null          the `! models.verify.ui is unused: …` line
import { globMatch } from "../../lane/gate.mjs";
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

// The contract's own model for `role`: `- **Model:** <model>` for a builder, `**Model (verify):** <model>`
// for a verifier; its first word, backticks dropped.
const LABEL = { build: "", verify: String.raw` \(verify\)` };
function contractModel(block, role) {
  const re = new RegExp(
    String.raw`^[ \t]*(?:[-*+][ \t]+)?\*\*model${LABEL[role]}:?\*\*:?[ \t]*(\S+)`,
    "im",
  );
  const word = re.exec(String(block ?? ""))?.[1].replace(/`/g, "");
  return word ? { model: word, from: "contract" } : null;
}

/** The model a dispatch of `role` ("build" or "verify") names, and where it came from: the contract's
 *  bullet, else for a builder `models.build`, for a verifier `models.verify.flagged` when the item is
 *  flagged, `.ui` when a designer builds it, else `.default`; a key by path takes its first entry matching
 *  an owned file, else its default. Null when nothing names one. */
export function modelFor(
  spec,
  role,
  { flagged = false, ui = false, owned = [], contract = "" } = {},
) {
  const named = contractModel(contract, role);
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
 *  UI task unflagged gets no verifier: a `models.verify.ui` set there is never used. The line saying so. */
export function unusedUiModel(models, verify) {
  if (own(own(models, "verify"), "ui") === undefined || !["flagged", "none"].includes(verify))
    return null;
  return `! models.verify.ui is unused: exec.verify is ${verify} and a UI task is verified only when flagged`;
}
