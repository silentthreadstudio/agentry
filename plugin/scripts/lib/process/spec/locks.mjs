// locks — the workflow file's `locks` checker: `{ "<name>": <slots, at least 1> }`, one entry or more, each
// name lower-case letters, digits and `-` (it names a directory under `.agentry/run/locks/`). Mirrors core's
// `Locks` (`packages/core/src/workflow.ts`). PURE: never reads, never throws.
import { isObject, join, like, posInt, record } from "./shape.mjs";

const lockName = like(/^[a-z0-9][a-z0-9-]*$/, "a name (lower-case letters, digits and -)");

/** The `locks` checker (`agentry run --lock`, `agentry lock take`). */
export const locks = (v, at, bad) => {
  record(posInt)(v, at, bad);
  if (!isObject(v)) return;
  if (Object.keys(v).length === 0) bad(at, "should not be empty");
  for (const k of Object.keys(v)) if (k !== "__proto__") lockName(k, join(at, k), bad);
};
