# Solo, fast

For one developer who wants a task built and landed with the least ceremony. Only tasks you mark get an
independent verifier; for everything else the gate is the check.

## What it sets

- `exec.preset: "lean"`: `exec.verify` is `flagged`, `noteRounds` 0, `final` never, `rebase` gate. A task
  with anything in its `Flag` cell gets a verifier. Every other task goes from built straight to the gate.
- `gate.tiers`: one tier, `npm test`. Change it to your own command (argv, no shell).
- `lifecycle`: the lane writes the task's status, verdict and landed commit into `BOARD.md`.
- `cleanup.disposable`: `node_modules` and `dist` are discarded without asking when a lane is cleaned up.
- `config.json`: `merge.push: "never"` keeps every land local, so you push when you choose.
  `lanes.maxWriters: 2` allows two builders at once.
- Rules: unique ids, known status words, a commit on every done task, and a passing verdict on every
  flagged done task.

## Files

| File | Goes to |
| :--- | :--- |
| `process.json` | `.agentry/process.json` |
| `workflow.json` | `.agentry/workflow.json` |
| `config.json` | `.agentry/config.json` |
| `board/BOARD.md`, `board/TASKS.md` | `docs/work/` |

```
mkdir -p .agentry docs/work
cp process.json workflow.json config.json .agentry/
cp board/* docs/work/
agentry board check
```

Then `/agentry:exec T1` builds the first task and `/agentry:merge T1` lands it.
