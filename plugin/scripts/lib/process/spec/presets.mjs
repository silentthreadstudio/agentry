// presets — the exec lane's workflow presets (A47, A48, #49) and the one home of their defaults: `lean`,
// `standard` (the default) and `strict`, each a value for every exec key a preset sets and the tier each gate
// role runs. A key the workflow file gives wins over its preset, `gate.roles` per role. Also the exec keys'
// load check, which `workflow.mjs` puts in the workflow schema. PURE: never reads, never throws.
//
//   PRESETS                       the table below, by name
//   DEFAULT_PRESET                "standard"
//   execSchema(kinds)             the checker of the `exec` key (`kinds` checks `exec.kinds`)
//   flagField(spec), idleMinutes(spec)   `exec.flagField` ("flag") and `exec.idleMinutes` (20): no preset
//                                 sets them; the idle threshold is read live, never from a ledger
//   resolveWorkflow(workflow) -> { preset, exec: { verify, noteRounds, final, rebase },
//                                  roles: { build, verify, merge } | null, set: string[] }
//
//   | key                       | lean               | standard           | strict             |
//   |---------------------------|--------------------|--------------------|--------------------|
//   | exec.verify               | flagged            | all                | all                |
//   | exec.noteRounds           | 0                  | 1                  | 3                  |
//   | exec.final                | never              | after-fix          | always             |
//   | gate.roles build/ver/merge| pick / none / pick | pick / none / pick | full / none / full |
//   | exec.rebase               | gate               | recheck            | recheck            |
import { FULL, is, isObject, oneOf, own, shape, text } from "./shape.mjs";

export const PRESETS = {
  lean: {
    exec: { verify: "flagged", noteRounds: 0, final: "never", rebase: "gate" },
    roles: { build: "pick", verify: "none", merge: "pick" },
  },
  standard: {
    exec: { verify: "all", noteRounds: 1, final: "after-fix", rebase: "recheck" },
    roles: { build: "pick", verify: "none", merge: "pick" },
  },
  strict: {
    exec: { verify: "all", noteRounds: 3, final: "always", rebase: "recheck" },
    roles: { build: "full", verify: "none", merge: "full" },
  },
};
export const DEFAULT_PRESET = "standard";

// A whole number from `min` (to `max`, when given).
const whole = (min, max) =>
  is(
    (v) => Number.isInteger(v) && v >= min && !(v > max),
    `should be a whole number ${max === undefined ? `of at least ${min}` : `from ${min} to ${max}`}`,
  );

/** The `exec` key's checker: its preset, which items a verifier reads (by which flag field), how many notes
 *  rounds a lane may run, when a final verifier comes, what checks a rebase, when a lane is idle, and
 *  `kinds` (checked by the given checker). Every key optional. */
export const execSchema = (kinds) =>
  shape(
    {
      preset: oneOf(...Object.keys(PRESETS)),
      verify: oneOf("all", "flagged", "none"),
      noteRounds: whole(0, 3),
      final: oneOf("never", "after-fix", "always"),
      rebase: oneOf("recheck", "gate"),
      flagField: text,
      idleMinutes: whole(5),
      kinds,
    },
    FULL,
  );

/** The field `exec.verify: "flagged"` and `"none"` read from each kind exec runs: `exec.flagField`, else
 *  "flag". */
export const flagField = (spec) => own(own(spec, "exec"), "flagField") ?? "flag";

/** How many quiet minutes make a building lane idle: `exec.idleMinutes`, else 20. */
export const idleMinutes = (spec) => own(own(spec, "exec"), "idleMinutes") ?? 20;

const EXEC_KEYS = ["verify", "noteRounds", "final", "rebase"];
const ROLE_KEYS = ["build", "verify", "merge"];

/** The workflow file's exec keys and gate roles with its preset's values filled in: `preset` (the file's
 *  `exec.preset`, else "standard"), `exec`, `roles` (null without a gate) and `set`, the keys the file
 *  gives itself (`["exec.final"]`), in that order. An unknown preset reads as the default (the load
 *  check refuses it). */
export function resolveWorkflow(workflow) {
  const exec = own(workflow, "exec");
  const named = own(exec, "preset");
  const preset = own(PRESETS, named) ? named : DEFAULT_PRESET;
  const set = named === undefined ? [] : ["exec.preset"];
  const fill = (from, keys, at, defaults) =>
    Object.fromEntries(
      keys.map((key) => {
        const value = own(from, key);
        if (value === undefined) return [key, defaults[key]];
        set.push(`${at}.${key}`);
        return [key, value];
      }),
    );
  const values = fill(exec, EXEC_KEYS, "exec", PRESETS[preset].exec);
  const gate = own(workflow, "gate");
  const roles = isObject(gate)
    ? fill(own(gate, "roles"), ROLE_KEYS, "gate.roles", PRESETS[preset].roles)
    : null;
  return { preset, exec: values, roles, set };
}
