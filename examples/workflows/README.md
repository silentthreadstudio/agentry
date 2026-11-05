# Example workflows

Four complete setups for `.agentry/`. Each folder holds the files Agentry reads and a small board that
passes `agentry board check` as it is. Each one loads with no errors under the plugin's own loader.

| Example | For | What it sets |
| :--- | :--- | :--- |
| [`solo-fast`](./solo-fast/) | One developer who wants speed | `lean` preset: verify flagged tasks only, no notes rounds; one gate tier; push never |
| [`careful-team`](./careful-team/) | A team that wants every change checked twice | `strict` preset: verify all, a final verifier, three notes rounds; a gate with tiers and a checklist; commit rules; push on ask |
| [`learned-board`](./learned-board/) | A repo that already has a board | Custom kinds and columns, as `/agentry:init` learns them: tickets in iterations, upper-case states, linked specs |
| [`debt-only`](./debt-only/) | Upkeep with no sprints | One debt kind as the lifecycle's kind, light contracts, one gate tier |

Each file goes in the same place:

| File | Goes to |
| :--- | :--- |
| `process.json` | `.agentry/process.json` |
| `workflow.json` | `.agentry/workflow.json` |
| `config.json` | `.agentry/config.json` |
| `board/*` | the folder `process.json` names as `root` |

Then run `agentry board check` and `agentry board explain`. `explain` shows each value with where it came
from (`preset` or `set`). Replace the gate command with your repo's own.

Every key is described on the site: [Workflows](https://agentry.silentthreadstudio.com/docs/workflows/).
`/agentry:init` writes these files for you, from your own board; the examples show the result.
