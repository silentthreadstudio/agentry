# Lanes — `exec` and `ask`

Reference for the `conducting` skill. A lane is an explicit command for work whose shape is already known, so it
skips routing. `/agentry:exec <task-id>` builds a contract that already exists; `/agentry:ask <question>` answers
a question. `/agentry:go` stays the full pipeline and never routes to a lane on its own.

## What a lane never does

- No right-sizing, no spec, plan or split step, no spec or plan gate. The planning already happened.
- No Flow MCP calls (`run_start`, `task_*`, `event_emit`, `artifact_write`, `review_*`, `backlog_*`).
- No files under `.agentry/work/` (`spec.md`, `plan.md`, `tasks/*.md`).
- No edits to the repo's board, task status or contract text. Status is derived elsewhere (hooks, the merge);
  the lane writes none.
- No merge, no push. The owner merges.

## exec

### 1. Find the contract

Run the `find-contract.mjs` command `exec.md` gives, with the id as one single-quoted argument (`exec.md`
states when it may run).

It prints one JSON line:

| `status` | Exit | Do |
| :--- | :--- | :--- |
| `found` | 0 | `block` is the contract (from `file`:`line`). Locations in `related`, if present, are context, not the contract. |
| `not-found` | 1 | Show the candidates as `file:line` and ask which one is meant, or for the file that holds it. |
| `ambiguous` | 1 | Show the candidates as `file:line` and ask which one is meant. |

If the script is missing, prints no JSON or exits with any other code, say so and ask the user for the file
and id. Don't search by hand and pick a block: a guessed contract builds the wrong thing. With no user to ask
(headless), stop and report.

### 2. Pick the builder

- **designer** when the contract is UI-shaped: its owned files are screens, components or styles, or its
  acceptance is judged on rendered output.
- **implementer** otherwise.

Dispatch it with `isolation: "worktree"`.

### 3. The build brief

The first line is exact; the marker is how hooks tie the dispatch to the task. Every dispatch starts with its
role's marker (`role=build` for builders, `role=verify` for verifiers), including each re-dispatch (a fix round,
a `NEEDS_CONTEXT` round, a verifier sent back for a missing `Verdict:` line): it is a new dispatch whose first
line is the marker.

```text
agentry-task: <id> role=build
Build contract <id> (<file>:<line>) in your worktree. The contract is the whole scope.

<the block, verbatim>

Owned files: <from the block>. Touch nothing else; a file outside this list is NEEDS_CONTEXT.
Acceptance: <from the block, verbatim>
Decisions it cites: <each row quoted from the repo's decisions file> | none
Recalled gotchas: <memories recalled for the owned files> | none
Related, not the contract: <file:line, from `related`>        (omit when absent)

Run the repo's checks. Commit on your worktree branch following the repo's commit conventions, with no AI
attribution. Do not merge or push.
Start your report with one of DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, BLOCKED; then the branch, the commits,
the checks you ran and their result, and any concern.
```

Quote decisions from the file, not from memory. Recall gotchas once for the owned files; write `none` if memory
isn't available.

### 4. Route the builder's report

| Status | Do |
| :--- | :--- |
| `DONE`, `DONE_WITH_CONCERNS` | Verify. Pass the concerns to the verifier and into the handoff. |
| `NEEDS_CONTEXT` | If the missing fact is already in the contract block, the repo or recalled memory, supply it and re-dispatch once: a new dispatch, marker line first, then the build brief, then the fact appended at the end. If the first builder committed anything, append the same `git reset --hard <first builder's branch>` line as the fix round (§6). Otherwise stop and ask the owner. |
| `BLOCKED` | Stop and report what blocks it and the smallest unblock. |

Never widen the contract: a file outside it or a decision it never made goes to the owner.

### 5. The verify brief

A fresh **verifier**, never the builder. It works in the builder's worktree, not a new one.

```text
agentry-task: <id> role=verify
Verify contract <id> (<file>:<line>) against its acceptance. You did not build it; try to prove it wrong.
Worktree: <path>  Branch: <branch>  Commits: <sha list>
Read and run there; edit nothing, commit nothing.

<the block, verbatim>

Builder's report: <status and concerns>
For each acceptance item: PASS, FAIL or UNVERIFIED, with the evidence (the command and its output, file:line,
a screenshot path). Check that the branch changes only the owned files.
Your last instruction: the final line of your report is exactly one of `Verdict: PASS`, `Verdict: PASS WITH
NOTES` or `Verdict: FAIL`, after `used_memories` and anything else.
```

A report without that last line is not a verdict: send it back once as a new dispatch: the verify marker
first, the same verify brief, then its earlier report appended with "end with the `Verdict:` line".

### 6. One fix round

On `FAIL`, dispatch a fresh builder (same role, `isolation: "worktree"`). The fix-round brief is, in order: the
marker line `agentry-task: <id> role=build`, then the build brief, then this text appended at the end:

```text
Attempt 2. Your worktree is new. First run `git reset --hard <first builder's branch>` so you continue exactly
from the first attempt, whatever main has moved on to.
Fix list, from the verifier's FAIL: <the failing items and their evidence>
```

Then verify again with a fresh verifier. A second `FAIL` ends the lane: report both verdicts to the owner. Don't
try a third time.

### 7. Handoff

```text
<id>: <verdict line>
Worktree: <path>  Branch: <branch>
Commits: <sha subject>, one per line
Notes: <PASS WITH NOTES items, UNVERIFIED items, builder concerns>
Left: <what the owner still has to do: review, merge, anything out of scope>
```

## ask

Dispatch exactly one specialist, chosen by where the answer lives:

| Question | Specialist |
| :--- | :--- |
| How this repo works, where something lives, why it behaves as it does (default) | explorer |
| The answer is outside the repo: a library's current API, a standard, an external service | researcher |
| A design question: how something should be structured, which approach fits | architect |

No `isolation: "worktree"`, no run handle.

```text
Answer this question; change nothing.
<the question>

Answer in your reply. No edits, no commits, no files written (no plan, ADR or research doc, nothing under
.agentry/), no memory writes, no Flow calls.
Cite every claim: path:line for code, a URL for outside sources. Say what you could not verify.
```

Relay the answer with its citations. If the question turns out to be a request to change something, say so and
point to `/agentry:exec` or `/agentry:go` rather than building.
