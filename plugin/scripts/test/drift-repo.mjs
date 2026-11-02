// drift-repo — a throwaway git repo holding a small board, for the tests of nudges, `board fix` and drafts. Not
// a test file: imported by drift/fix-cli/status tests. Git runs through git-repo.mjs's scrubbed environment.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "../lib/lane/worktree.mjs";
import { write as writeLedger } from "../lib/process/ledger.mjs";
import { commitFile, git, gitEnv } from "./git-repo.mjs";

export const BOARD = join(dirname(fileURLToPath(import.meta.url)), "..", "board.mjs");

export const SPEC = {
  version: 1,
  name: "Drift",
  root: "plan",
  kinds: {
    sprint: {
      label: "Sprint",
      at: { table: "BOARD.md", heading: "Sprints" },
      id: { column: "Sprint" },
      fields: { status: { column: "Status" } },
      status: { field: "status", values: { todo: "planned", doing: "active", done: "done" } },
      file: {
        glob: "sprints/{id}.md",
        sections: { handoff: { heading: "Handoff", as: "bold-lead" } },
      },
    },
    task: {
      label: "Task",
      at: { table: "BOARD.md", heading: "Tasks" },
      id: { column: "Task" },
      fields: {
        sprint: { column: "Sprint", type: "ref", ref: "sprint", role: "parent" },
        status: { column: "Status" },
        verdict: { column: "Verdict" },
        commit: { column: "Commit", type: "commits" },
        note: { column: "Note" },
      },
      status: {
        field: "status",
        values: { todo: "planned", doing: "active", verify: "active", done: "done" },
      },
    },
    decision: {
      label: "Decision",
      at: { table: "DECISIONS.md", heading: "Decisions" },
      id: { column: "#" },
      fields: { decision: { column: "Decision" }, why: { column: "Why" } },
      create: {
        ask: ["decision", "why"],
        id: "D{n}",
        rows: [
          {
            in: "self",
            at: "end",
            cells: { "#": "{id}", Decision: "{decision}", Why: "{why}" },
          },
        ],
      },
    },
  },
  rules: [
    { rule: "ids-unique" },
    { rule: "status-known" },
    { rule: "done-has-evidence", kind: "task", field: "commit", evidence: "commit" },
    { rule: "done-has-handoff", kind: "task", section: "handoff", commit: "first" },
  ],
  lifecycle: {
    kind: "task",
    on: { dispatched: "doing", built: "verify", failed: "doing", merged: "done" },
    write: {
      status: "status",
      verdict: "verdict",
      commit: "commit",
      handoff: "parent.file:handoff",
    },
    handoff: "- **{id}** ({sha}): {summary}",
  },
  drafts: { decision: { kind: "decision", map: { decision: "{answer}", why: "{question}" } } },
  conductor: { prompt: "CONDUCTOR.md", rules: "Standing rules" },
};

export const BOARD_MD = `# Drift

## Sprints

| Sprint | Status |
| ------ | ------ |
| S1     | doing  |

## Tasks

| Task | Sprint | Status | Verdict | Commit | Note       |
| ---- | ------ | ------ | ------- | ------ | ---------- |
| T1   | S1     | doing  |         |        | The first  |
| T2   | S1     | todo   |         |        | The second |
| T3   | S1     | verify |         |        | The third  |
`;
export const SPRINT_MD = "# S1\n\n## Handoff\n\n## Notes\n\nNothing yet.\n";
export const DECISIONS_MD =
  "# Decisions\n\n## Decisions\n\n| # | Decision | Why |\n| --- | --- | --- |\n| D1 | First | Because |\n";
export const CONDUCTOR_MD =
  "# Conductor\n\n## Standing rules\n\n- Existing rule.\n\n## Modes\n\nNone.\n";

/** A repo on `main` with the board, the process file and a conductor prompt, committed. `spec` replaces the
 *  process file's content. `{ root, cleanup }`; `root` is the real path. */
export function boardRepo({ spec = SPEC } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentry-drift-")));
  mkdirSync(join(root, "plan", "sprints"), { recursive: true });
  mkdirSync(join(root, ".agentry"));
  writeFileSync(join(root, ".agentry", "process.json"), JSON.stringify(spec, null, 2));
  writeFileSync(join(root, ".gitignore"), ".agentry/run/\n");
  writeFileSync(join(root, "plan", "BOARD.md"), BOARD_MD);
  writeFileSync(join(root, "plan", "DECISIONS.md"), DECISIONS_MD);
  writeFileSync(join(root, "plan", "sprints", "S1.md"), SPRINT_MD);
  writeFileSync(join(root, "CONDUCTOR.md"), CONDUCTOR_MD);
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "board");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Agentry's own worktree for `id` (`agentry/<id>`) with one commit on it; `{ path, branch, sha }`. */
export function builtBranch(root, id, file = `${id}.txt`) {
  const { path, branch } = create(root, { id, base: "main" });
  const sha = commitFile(path, file, `work of ${id}\n`, `feat: ${id}`);
  return { path, branch, sha };
}

/** A worktree some agent made by hand: its own directory and branch name, one commit. */
export function handBranch(root, dir, branch, file = "hand.txt") {
  const path = join(root, dir);
  git(root, "worktree", "add", "-q", "-b", branch, path, "main");
  const sha = commitFile(path, file, `by hand ${branch}\n`, `feat: ${branch}`);
  return { path, branch, sha };
}

/** Cherry-pick `sha` onto main by hand; returns the new commit on main. Main moves on first, so the pick
 *  is a new commit and not the branch's own commit reappearing (same parent, same second, same SHA). */
export function pickOntoMain(root, sha) {
  commitFile(root, `moved-${sha.slice(0, 7)}.txt`, "main moved\n", "chore: main moves on");
  git(root, "cherry-pick", sha);
  return git(root, "rev-parse", "HEAD");
}

/** The merge record `lane merge` keeps: main's head before the picks, the branch commits it planned to
 *  pick (oldest first), the branch tip and main's `landed` commits. */
export const mergeRecord = (preHead, planned, landed) => ({
  preHead,
  planned,
  tip: planned.at(-1),
  landed,
  step: "done",
});

/** Land `shas` (branch commits, oldest first) on main as `lane merge` does, main moving on first (see
 *  `pickOntoMain`), and write `id`'s merged ledger with its record. Returns main's landed commits. */
export function mergeOntoMain(root, id, shas) {
  commitFile(root, `moved-${shas[0].slice(0, 7)}.txt`, "main moved\n", "chore: main moves on");
  const preHead = git(root, "rev-parse", "HEAD");
  git(root, "cherry-pick", ...shas);
  const landed = git(root, "rev-list", "--reverse", `${preHead}..HEAD`).split("\n");
  ledger(root, id, { state: "merged", merge: mergeRecord(preHead, shas, landed) });
  return landed;
}

/** Write a v1 ledger for `id` into the repo's run state. */
export function ledger(root, id, extra = {}) {
  return writeLedger(root, {
    v: 1,
    id,
    kind: "task",
    contract: { file: "plan/BOARD.md", line: 1 },
    origin: "exec",
    mainBranch: "main",
    base: "main",
    worktree: join(root, ".agentry", "run", "worktrees", id),
    branch: `agentry/${id}`,
    rounds: [],
    gates: [],
    checks: {},
    usedMemories: [],
    state: "building",
    next: "report",
    ...extra,
  });
}

/** The board CLI in `root`; `{ status, stdout, stderr }`. */
export function board(root, ...args) {
  return spawnSync("node", [BOARD, ...args, "--root", root], {
    encoding: "utf8",
    env: { ...gitEnv, NO_COLOR: "1" },
  });
}

export const read = (root, rel) => readFileSync(join(root, rel), "utf8");
