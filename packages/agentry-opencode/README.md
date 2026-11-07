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
checkout is required. This previews; add `--apply` to write:

```
npx agentry-opencode init --host opencode
npx agentry-opencode init --host opencode --apply
```

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
node vendor/bin/agentry <board|lane|mem|init> …   # also on PATH as agentry-opencode
```

Requirements: Node ≥ 24 (the CLI core is a Node program). Node built-ins only — the package has no
dependencies.
