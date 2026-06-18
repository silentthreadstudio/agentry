<!-- Thanks for contributing to Agentry. Keep the change focused and held to the bar in CONTRIBUTING.md. -->

## What & why

<!-- What does this change do, and why? Link any issue: "Closes #123". -->

## Type of change

- [ ] Bug fix
- [ ] New feature / enhancement
- [ ] Refactor / cleanup (no behavior change)
- [ ] Docs
- [ ] CI / tooling
- [ ] Plugin payload (agents / commands / skills / hooks)

## Checklist

- [ ] `node scripts/check-plugin.mjs` (`pnpm check`) passes
- [ ] `pnpm -r typecheck` and `pnpm -r test` pass
- [ ] If I changed `packages/memory/src`: I ran `pnpm --filter @agentry/memory build` and committed the
      updated `plugin/mem/index.js` (+ `.srchash`) in this PR (**dist-lockstep**)
- [ ] If I changed the plugin payload (agents/commands/skills/hooks/MCP): I verified it **live after a
      reload/restart** (these are reload-gated)
- [ ] The change is right-sized (no god-files, no over-abstraction) and contract types stay in `@agentry/core`

## Notes for reviewers

<!-- Anything non-obvious: a design fork you took, a trade-off, something to look at closely. -->
