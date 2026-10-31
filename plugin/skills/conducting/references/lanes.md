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

Pass the id as one single-quoted argument. If it contains anything other than letters, digits, `-`, `_`, `.`
or `/`, ask the user before running it.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/find-contract.mjs" '<id>'
```

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

Dispatch it with `isolation: "worktree"`. Before dispatching, count builders already running in this session:
respect the cap on concurrent builders the repo's instructions state, or three if they state none. At the cap,
wait for one to finish.

### 3. The build brief

The first line is exact; the marker is how hooks tie the dispatch to the task.

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
| `NEEDS_CONTEXT` | If the missing piece is a fact you can supply without changing the contract, supply it and re-dispatch once. If it needs a file outside the contract or a decision the contract never made, stop and report it to the owner. |
| `BLOCKED` | Stop and report what blocks it and the smallest unblock. |

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
End with one line `Verdict: PASS | PASS WITH NOTES | FAIL`.
```

A report without that last line is not a verdict: send it back once for the line.

### 6. One fix round

On `FAIL`, dispatch a fresh builder (same role, `isolation: "worktree"`) with the build brief plus:

```text
Attempt 2. Start from branch <branch>: `git merge --ff-only <branch>`.
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
