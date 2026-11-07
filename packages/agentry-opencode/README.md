# agentry-opencode

Agentry for [OpenCode](https://opencode.ai): the conductor, its specialists and its board, lane and
memory workflow, as one V2 plugin of native tools over the `agentry` CLI. The plugin registers
`agentry_board`, `agentry_lane` and `agentry_mem` — and the writing halves of each — which run the
same CLI logic your terminal does, in-process. Every feature keeps its Tier-1 CLI fallback: the
package ships `vendor/bin/agentry`, so the `shell` tool can run the full CLI (`agentry board …`,
`agentry lane …`, `agentry mem …`) even in a workspace that never vendored one.

## Install

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

Per project: rerun `npx agentry-opencode@<new> init --host opencode --vendor --apply` in the repo.

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
