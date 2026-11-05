# Careful team

For a team that wants every change verified, reviewed once more at the end, and landed only past the full
gate.

## What it sets

- `exec.preset: "strict"`: every task gets a verifier (`verify: all`), up to three notes rounds, a fresh
  final verifier every time (`final: always`), and a rebase rechecked by a verifier. The preset also runs
  the full tier for the lane's gate and the land's.
- `gate.tiers`: a `docs` tier (`npm run lint:docs`) for a change that touches only docs and Markdown, then
  `full` (`npm run ci`) for everything else.
- `gate.roles.build: "pick"`: a lane's own gate picks the first tier that applies, so a docs-only lane runs
  the `docs` tier. The land keeps the preset's `full`: main always gets the whole gate.
- `gate.checklist`: `ui-smoke`, a manual check the land waits on when the change touches `src/ui/**`.
  Record it with `agentry lane merge <id> --check ui-smoke=pass`.
- `gate.after`: `CHANGELOG.md` may change after the gate ran green.
- `models`: builders and verifiers on `sonnet`, a flagged task's verifier on `opus`.
- `briefs`: policy lines printed in every builder and verifier brief.
- `commits`: subjects of at most 72 characters in Conventional Commits form, and no `Co-Authored-By:`
  trailer. A builder's commit that breaks one goes back for a fix round; the land refuses it.
- `guard.allow`: `docs/STATUS.md` may be edited on main while lanes run.
- `cleanup.disposable`: `node_modules`, `dist` and `coverage`.
- `config.json`: `merge.push: "ask"` (the default, written out): main is pushed only on a yes.
  `lanes.maxWriters: 3`.
- Rules: sprints worked in order, dependencies done first, a contract for every ready task, a commit on every
  done task, a passing verdict on every flagged one.

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

Replace the two gate commands and the commit pattern with your repo's own. `agentry board commits --learn`
prints the rules your history already keeps.
