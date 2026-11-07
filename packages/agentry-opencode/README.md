# agentry-opencode

Agentry for [OpenCode](https://opencode.ai): the conductor, its specialists and its board, lane and
memory workflow, as one V2 plugin of native tools over the `agentry` CLI. The plugin registers
`agentry_board`, `agentry_lane` and `agentry_mem` — and the writing halves of each — which run the
same CLI logic your terminal does, in-process. Every feature keeps its Tier-1 CLI fallback: the
package ships `vendor/bin/agentry`, so the `shell` tool can run the full CLI (`agentry board …`,
`agentry lane …`, `agentry mem …`) even in a workspace that never vendored one.

## Install

OpenCode is supported from Agentry 0.4.0. The package is on npm under `latest`, so no tag is needed.

```
opencode plugin add agentry-opencode
```

Restart the OpenCode service so the plugin loads (do it after every update too):

```
opencode service restart
```

Then give the repo its agents, commands and skills. The package carries what it needs, so no Agentry
checkout is required. `--vendor` copies the CLI into the repo's `.agentry/`, so the agents' CLI fallback
works without a checkout. Without `--apply` this previews:

```
npx agentry-opencode init --host opencode --vendor --apply
```

In a repo with no learned process the AGENTS.md block is skipped, and the command says so. In OpenCode, run
`/agentry/init` to learn your board, then run the init again to add the AGENTS.md block.

### Install globally

One copy of the payload for every repo, in OpenCode's global config dir (`$XDG_CONFIG_HOME/opencode`, else
`~/.config/opencode`):

```
npm install -g agentry-opencode
opencode plugin add agentry-opencode
opencode service restart
agentry init --host opencode --global --apply
```

Then, per repo, run `/agentry/init` in OpenCode to learn the board, and `agentry init --host opencode --apply`
for the repo's `AGENTS.md` block. Run that repo init without `--vendor`; its payload overrides the global one.
`--global` writes only agents, commands and skills, never touches a repo, and never removes your own files
there; `--global` with `--vendor` is refused.

Per project pins the version in each repo and is shared through `.opencode/`; global is one copy for all repos.

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
