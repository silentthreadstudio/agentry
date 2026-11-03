// spec-files — a merged spec (today's one-object shape, as a test builds it) as the two files the loader
// reads: the process file (the board keys, and any key in neither list, so a typo stays the board's) and
// its sibling workflow file (the workflow keys).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKFLOW_KEYS } from "../lib/process/spec.mjs";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** `{ board, workflow }` of a merged spec, as `validateSpec` takes them: `workflow` is undefined when
 *  the spec sets no workflow key (no workflow file). A value that is not an object is all board. */
export function splitSpec(merged) {
  if (!isObject(merged)) return { board: merged, workflow: undefined };
  const part = (inWorkflow) =>
    Object.fromEntries(
      Object.entries(merged).filter(([k]) => WORKFLOW_KEYS.includes(k) === inWorkflow),
    );
  const workflow = part(true);
  return { board: part(false), workflow: Object.keys(workflow).length ? workflow : undefined };
}

/** Write a merged spec into `dir` (made when missing) as `name` (the process file) and its sibling `workflow.json`; with no
 *  workflow key, no workflow file (one left from an earlier write is removed). Returns the process
 *  file's path. */
export function writeSpec(dir, merged, name = "process.json") {
  const { board, workflow } = splitSpec(merged);
  const file = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(board, null, 2)}\n`);
  const sibling = join(dir, "workflow.json");
  if (workflow) writeFileSync(sibling, `${JSON.stringify(workflow, null, 2)}\n`);
  else rmSync(sibling, { force: true });
  return file;
}
