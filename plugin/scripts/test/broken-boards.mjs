// Test support (not a test): the table-board fixture, one valid entry per catalog rule, and the edit
// to its board under which each rule fires. `outcome` judges a process file the way `board check`
// does (2 = the file is refused, 1 = findings, 0 = OK), in process, so a fuzz can run thousands.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "../lib/process/check.mjs";
import { findContract } from "../lib/process/contract.mjs";
import { readProcess } from "../lib/process/read.mjs";
import { checkOnBoard, validateSpec } from "../lib/process/spec.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const BASE = join(HERE, "fixtures", "table-board");
export const VALID = JSON.parse(readFileSync(join(BASE, "process.json"), "utf8"));
export const BUILTINS = ["toString", "constructor", "__proto__", "hasOwnProperty"];

// One entry per catalog rule that is valid on table-board, so a mutation is the only thing wrong.
export const ENTRIES = {
  "ids-unique": {},
  "status-known": {},
  "refs-resolve": {},
  "file-required": { kind: "sprint" },
  "members-listed": { kind: "sprint", section: "members", member: "task" },
  "deps-done": { kind: "task", field: "deps" },
  "parent-active": { kind: "task" },
  sequential: { kind: "sprint", skip: ["PRE", "TRK", "LATER"] },
  "question-blocks": { kind: "question", field: "blocks" },
  parked: { kind: "task", parking: "LATER" },
  "deps-not-forward": { kind: "task", field: "deps", skip: ["LATER"] },
  "ready-has-contract": { kind: "task", skip: ["LATER"] },
  "done-has-evidence": { kind: "task", field: "commit", evidence: "commit" },
  "done-has-handoff": { kind: "task", section: "handoff", commit: "first" },
  "flagged-needs-verdict": { kind: "task", flag: "risky", verdict: "verdict", pass: ["PASS"] },
  "closed-children": { kind: "sprint" },
  "done-signoff": { kind: "sprint", field: "ok" },
};

// table-board's BOARD.md edited ([from, to] pairs) so each rule fires as ENTRIES writes it.
export const BREAK = {
  "ids-unique": [["| W2 | A1 | done | W1 |", "| W1 | A1 | done | W1 |"]],
  "status-known": [["| W4 | A2 | todo | W3 |", "| W4 | A2 | toString | W3 |"]],
  "refs-resolve": [["| W4 | A2 | todo | W3 |", "| W4 | A2 | todo | W3, NOPE9 |"]],
  "file-required": [["| TRK | Tracks", "| C1 | No file yet | todo |  |\n| TRK | Tracks"]],
  "members-listed": [["| W5 | B1 | todo | W4 |", "| W5 | A2 | todo | W4 |"]],
  "deps-done": [["| W4 | A2 | todo | W3 |", "| W4 | A2 | doing | W3 |"]],
  "parent-active": [["| W5 | B1 | todo |", "| W5 | B1 | doing |"]],
  sequential: [["(sprints/B1_the_door.md) | todo |", "(sprints/B1_the_door.md) | doing |"]],
  "question-blocks": [["| W5 | B1 | todo |", "| W5 | B1 | doing |"]],
  parked: [["| W5 | B1 | todo | W4 |", "| W5 | LATER | todo | W4 |"]],
  "deps-not-forward": [["| W2 | A1 | done | W1 |", "| W2 | A1 | done | W1, W5 |"]],
  "ready-has-contract": [], // W4 is in the open A2 with no contract
  "done-has-evidence": [], // W0 is done without a commit
  "done-has-handoff": [], // W0's sprint PRE has no file
  "flagged-needs-verdict": [["| ⚑ | PASS | a1b2c3d |", "| ⚑ | FAIL | a1b2c3d |"]],
  "closed-children": [["| W2 | A1 | done | W1 |", "| W2 | A1 | todo | W1 |"]],
  "done-signoff": [["| done | 2026-01-12 |", "| done |  |"]],
};

/** A temporary copy of table-board with rule `id`'s edit made (none for `id` undefined); the caller
 *  removes it with `rmSync(root, { recursive: true })`. */
export function brokenBoard(id) {
  const root = mkdtempSync(join(tmpdir(), "broken-board-"));
  cpSync(BASE, root, { recursive: true });
  const board = join(root, "docs", "board", "BOARD.md");
  let text = readFileSync(board, "utf8");
  for (const [from, to] of BREAK[id] ?? []) {
    if (!text.includes(from)) {
      rmSync(root, { recursive: true, force: true });
      throw new Error(`${id}: the board has no "${from}"`);
    }
    text = text.replace(from, to);
  }
  writeFileSync(board, text);
  return root;
}

/** `board check` on `root` with this process file, in process (every commit is taken as in git):
 *  { exit, messages }, the messages being the refusal's problems or the findings. */
export function outcome(spec, root) {
  const { problems } = validateSpec(spec);
  if (problems.length) return { exit: 2, messages: problems.map((p) => p.message) };
  const model = readProcess({ root, spec });
  const late = checkOnBoard(spec, model);
  if (late.length) return { exit: 2, messages: late.map((p) => p.message) };
  const ctx = {
    hasCommit: () => true,
    contractOf: (kind, id) => findContract({ root, spec, id, kind }),
  };
  const found = [...model.problems, ...check(model, spec.rules, ctx)];
  return { exit: found.length ? 1 : 0, messages: found.map((f) => `${f.rule}: ${f.message}`) };
}
