# Debt only

For a repo with no sprints or roadmap on its board, only upkeep: renames, removals, chores. Each item is one
row and a light contract, built in its own lane and landed like any task.

## What it sets

- One kind, `debt`, in `docs/DEBT.md`. It is the lifecycle's kind, so `/agentry:exec DEBT-1` and
  `/agentry:merge DEBT-1` run it directly.
- `create`: `/agentry:new debt` asks what it is, the files it owns and its acceptance, then adds the row
  and the contract block under `# Contracts`.
- `lifecycle`: status, verdict and the landed commit are written into the table as the lane moves.
- `gate.tiers`: one tier, `cargo test`. Change it to your own command.
- The `standard` preset by default: every item gets a verifier, one notes round.
- `cleanup.disposable`: `target`.

A repo that has sprints and debt side by side keeps tasks as the lifecycle's kind and adds debt under
`exec.kinds` instead; the `/agentry:init` templates do that.

## Files

| File | Goes to |
| :--- | :--- |
| `process.json` | `.agentry/process.json` |
| `workflow.json` | `.agentry/workflow.json` |
| `board/DEBT.md` | `docs/` |

```
mkdir -p .agentry docs
cp process.json workflow.json .agentry/
cp board/DEBT.md docs/
agentry board check
```
