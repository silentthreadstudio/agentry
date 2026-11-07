# agentry-opencode

Agentry for [OpenCode](https://opencode.ai): the conductor, its specialists and its board, lane and
memory workflow, as one V2 plugin of native tools over the `agentry` CLI. The plugin registers
`agentry_board`, `agentry_lane` and `agentry_mem` — and the writing halves of each — which run the
same CLI logic your terminal does, in-process. Every feature keeps its Tier-1 CLI fallback: the
package ships `vendor/bin/agentry`, so the `shell` tool can run the full CLI (`agentry board …`,
`agentry lane …`, `agentry mem …`) even in a workspace that never vendored one.

## Install

### What you are installing

One npm package, `agentry-opencode`, used in two ways:

- **OpenCode loads it as a plugin.** `opencode plugin add` writes an entry in `opencode.jsonc`, and OpenCode fetches
  its own copy into its own cache. That copy is not on your PATH.
- **You install or run it as the CLI.** `npm install -g agentry-opencode` (or `npx agentry-opencode`) gives you the
  `agentry` command, which the agents run in the shell. The same package carries the agents, commands and skills
  that `agentry init` writes for OpenCode to read.

So the plugin and the CLI are the same package installed twice, for two readers: OpenCode, and your shell.

The plugin gives the agents native tools, with structured input and output and OpenCode's permission prompt on
writes:

| Tool | What it does |
|---|---|
| `agentry_board` | Reads the board: status, check, explain, contract, next-id, commits, scan, draft list, instructions. |
| `agentry_board_write` | Changes the board: add, set, fix, draft. Previews unless `--apply` is passed. |
| `agentry_lane` | Reads lanes: session start, the sweep plan, a lane's ledger (`exec show`). |
| `agentry_lane_drive` | Drives lanes: exec steps, merge, sweep `--apply`, note, spike, session close. |
| `agentry_mem` | Reads memory: recall, search, stats. |
| `agentry_mem_write` | Changes memory: write, update, forget, feedback, episode. |

Without the plugin the agents fall back to running `agentry ...` in the shell, so everything still works. The CLI
is for the same board, lane and memory operations from your terminal or the agents' shell, plus `init`.

An OpenCode setup has three pieces:

| Piece | What it is |
|---|---|
| CLI | `agentry`, which the agents run in the shell. |
| Agents, commands and skills | Files OpenCode reads. |
| Plugin | The native `agentry_board`, `agentry_lane` and `agentry_mem` tools, loaded from OpenCode's config. Recommended; without it, the agents fall back to the CLI. |

The package, `agentry-opencode`, is on npm. It needs OpenCode V2 and Node 24 or newer. Pick one install.

### Global install

Recommended for one person across all repos. Run these in this order:

```
npm install -g agentry-opencode
opencode plugin add agentry-opencode@0.4.2
opencode service restart
agentry init --host opencode --global --apply
```

Then, in each repo, run `/agentry/init` in OpenCode to learn or scaffold the board, and run
`agentry init --host opencode --apply` to add the `AGENTS.md` block. Run that repo init without `--vendor`; its
payload overrides the global one. `--global` writes only agents, commands and skills, never touches a repo, and
never removes your own files there; `--global` with `--vendor` is refused.

### Per-project install

Pins the version in the repo and can be shared by committing `.opencode/`:

```
opencode plugin add agentry-opencode@0.4.2
opencode service restart
npx agentry-opencode@0.4.2 init --host opencode --vendor --apply
```

Then run `/agentry/init` in OpenCode, and run the same `npx agentry-opencode@0.4.2 init --host opencode --vendor --apply`
again to add the `AGENTS.md` block. `--vendor` copies the CLI into the repo's `.agentry/`, so nothing global is
needed.

### Pin the plugin version

Write `agentry-opencode@<version>` in `opencode plugin add`, never `@latest`: OpenCode caches the version it
first fetched for `@latest` and does not refetch it, so an update silently does nothing. Keep exactly one
`agentry-opencode` entry in `opencode.jsonc`, because running `plugin add` again adds a second line.

### Updating

Global:

1. Edit the version in the existing `"agentry-opencode@<version>"` line in `~/.config/opencode/opencode.jsonc`,
   or run `opencode plugin add agentry-opencode@<new>` and delete the old line.
2. `opencode service restart`
3. `npm install -g agentry-opencode@<new>`
4. `agentry init --host opencode --global --apply`

Per project: update the plugin line and restart (steps 1 and 2), then rerun
`npx agentry-opencode@<new> init --host opencode --vendor --apply` in the repo.

Init previews changes, rewrites only Agentry's generated files, keeps your own files, and does nothing when
already in sync.

### Check it worked

- `agentry --version` prints `0.4.2`.
- `opencode debug agents` lists `agentry/conductor` and the 8 specialists.
- In OpenCode, typing `/agentry` shows the commands. Commands are namespaced: `/agentry/init`, not `/agentry:init`.

Without `--apply`, init previews. The AGENTS.md block waits for a learned process, so a first run in a repo
skips it and says so.

## Notes

- **Specs pin once they resolve.** A process spec resolves to its lanes the first time a session
  reads it; later edits do not re-shape it. Bump the spec (and restart) to move it — the same rule
  the opencode-cockpit plugin follows.
- **Search ranks may differ slightly by runtime.** Where the runtime has `node:sqlite`, memory
  recall/search uses its FTS5 index; without it, a pure-JS token scan with the same relevance rule
  runs instead. The same facts are found either way; order can differ slightly.

## The CLI fallback

The upgraded-first path stays the CLI. When the native tools cannot reach the core, run the vendored
bin directly:

```
node vendor/bin/agentry <board|lane|mem|init> …   # also on PATH as agentry and agentry-opencode
```

Requirements: Node ≥ 24 (the CLI core is a Node program). Node built-ins only — the package has no
dependencies.
