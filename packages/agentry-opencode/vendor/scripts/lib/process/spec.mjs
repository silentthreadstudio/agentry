// spec — the process file (`.agentry/process.json`, the board: `spec/board.mjs`) and its sibling workflow
// file (`workflow.json`, optional, how the harness works: `spec/workflow.mjs`) composed into one spec, by
// hand: it mirrors core's zod schemas (`packages/core/src/{process,workflow}.ts`; the plugin ships no
// dependency). A key of the other file is refused by name, with the file it belongs in; the checks that
// read both files are `spec/across.mjs`'s. Each problem names the file holding the key it is about.
// PURE: never reads, never throws. The loader (`read.mjs` `loadSpec`) reads the two files.
import { basename } from "node:path";
import { checkAcross, checkProbes } from "./spec/across.mjs";
import { boardSchema, validateBoard } from "./spec/board.mjs";
import { isObject, namesOf } from "./spec/shape.mjs";
import { validateWorkflow, workflowSchema } from "./spec/workflow.mjs";

/** The process file's keys (the board) and the workflow file's, as their schemas declare them. */
export const BOARD_KEYS = namesOf(boardSchema.keys);
export const WORKFLOW_KEYS = namesOf(workflowSchema.keys);

// `value` without the keys of the other file (each reported as misplaced instead of unknown).
const without = (value, keys) =>
  isObject(value)
    ? Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)))
    : value;
const misplaced = (value, keys, says, bad) => {
  for (const k of Object.keys(isObject(value) ? value : {})) if (keys.includes(k)) bad(k, says);
};
// The top-level key a problem path starts with: `rules[2].kind` → `rules`.
const topOf = (at) => at.split(/[.[ ]/)[0];

/** Validate the two parsed files: `{ spec, problems }`, each problem a Finding with rule "spec" and,
 *  given `files` ({ board, workflow }: their paths), the `file` that holds the key. `workflow`
 *  undefined is no workflow file: every workflow key absent. `spec` is the merged value
 *  `{ ...board, ...workflow }` even when it has problems, so a reader can use what is sound; null
 *  when either file is not an object. */
export function validateSpec({ board, workflow } = {}, { files = {} } = {}) {
  const problems = [];
  const badIn = (file) => (at, message) =>
    problems.push({ rule: "spec", message: `${at} ${message}`, ...(file ? { file } : {}) });
  const bad = { board: badIn(files.board), workflow: badIn(files.workflow) };
  misplaced(board, WORKFLOW_KEYS, "is a workflow key: it belongs in workflow.json", bad.board);
  const ownBoard = without(board, WORKFLOW_KEYS);
  validateBoard(ownBoard, bad.board);
  let ownWorkflow = {};
  if (workflow !== undefined) {
    const name = basename(files.board ?? "process.json");
    misplaced(workflow, BOARD_KEYS, `is a board key: it belongs in ${name}`, bad.workflow);
    ownWorkflow = without(workflow, BOARD_KEYS);
    validateWorkflow(ownWorkflow, bad.workflow);
  }
  if (!isObject(ownBoard) || !isObject(ownWorkflow)) return { spec: null, problems };
  const spec = { ...ownBoard, ...ownWorkflow };
  const across = (at, message) =>
    (BOARD_KEYS.includes(topOf(at)) ? bad.board : bad.workflow)(at, message);
  checkAcross(spec, across);
  if (problems.length === 0) checkProbes(spec, across);
  return { spec, problems };
}

/** Parse the two files' texts (`workflow` undefined or null: no workflow file), then validate them.
 *  A text that is not valid JSON is a problem of its file, and the spec is null. */
export function parseSpec({ board, workflow } = {}, { files = {} } = {}) {
  const problems = [];
  const parse = (text, file) => {
    if (text === undefined || text === null) return undefined;
    try {
      return JSON.parse(text);
    } catch (e) {
      const problem = { rule: "spec", message: `not valid JSON (${e.message})` };
      problems.push(file ? { ...problem, file } : problem);
    }
  };
  const value = {
    board: parse(board ?? "", files.board),
    workflow: parse(workflow, files.workflow),
  };
  if (problems.length) return { spec: null, problems };
  return validateSpec(value, { files });
}
