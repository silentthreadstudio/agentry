// extensions — the workflow file's `extensions` key: the repo skills each command runs as checks, `merge`
// (before a land), `start` and `close` (a session's opening and ending, A42), each `{ checks: [<skill>, …] }`.
// The checker for the schema entry in `workflow.mjs` and the accessor the session readers share, both
// PURE; and `skillExists`, which looks for a named skill on disk.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FULL, distinct, has, isObject, like, own, shape } from "./shape.mjs";

const PHASES = ["merge", "start", "close"];
const skill = like(/^[a-z0-9][a-z0-9-]*$/, "a skill name (lower-case letters, digits and -)");
const skillChecks = shape({ "checks!": distinct(skill) }, FULL);
const phases = shape(Object.fromEntries(PHASES.map((p) => [p, skillChecks])), FULL);

/** The `extensions` checker: each phase optional, at least one named. Carries `keys` for the format reference. */
export const extensions = Object.assign(
  (v, at, bad) => {
    phases(v, at, bad);
    if (isObject(v) && !PHASES.some((p) => has(v, p)))
      bad(at, `names none of ${PHASES.join(", ")}`);
  },
  { keys: phases.keys },
);

/** The repo skills `/agentry:start` (`phase` "start") or `/agentry:close` ("close") runs and records as
 *  checks (`extensions.<phase>.checks`); `[]` when the workflow file names none. */
export const sessionChecks = (spec, phase) => {
  const checks = own(own(own(spec, "extensions"), phase), "checks");
  return Array.isArray(checks) ? [...checks] : [];
};

// Repo skills live in the host's own folder (A28); `extensions.merge.checks` names them natively.
export const SKILL_DIR = ".claude/skills";
export const skillExists = (root, name) => existsSync(join(root, SKILL_DIR, name, "SKILL.md"));
