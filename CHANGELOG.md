# Changelog

All notable changes to Agentry are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Pre-1.0, the version
scheme is pragmatic: patch releases carry fixes, docs, and small additions.

## [Unreleased]

## [0.1.2] — 2026-06-18

### Added
- This changelog.

## [0.1.1] — 2026-06-18

The "failure-to-merged" arc — Agentry can now take a change from a failure
report all the way to a merged, green branch.

### Added
- **`/agentry:fix`** — a repro-first debug front door: reproduce (a failing test
  that captures the bug) → isolate → fix → leave a regression guard → remember
  the gotcha. For a stack trace, a failing test, a red CI log, or a perf
  regression.
- **`/agentry:ship`** — the last mile: branch → commit → open PR → watch CI →
  merge, stopping at an **authorization boundary** before anything leaves the
  machine (push / PR-open / merge are gated by default, per-action configurable;
  auto-pilot records-and-stops, never auto-merges).
- **`shipping`** skill carrying that boundary and the last-mile playbook;
  conventions (VCS CLI, PR template, branch naming, CI provider, co-author
  trailer) are discovered from the target repo at runtime, not baked in.
- **Routing kind axis** — the conductor now classifies *kind*
  (`feature | bug | refactor | perf | dep-upgrade | ci-red`) orthogonally to the
  *complexity* shape (one-shot / spec-first / decompose+verify); kind selects the
  discipline, complexity selects the process weight.
- **Self-eval** gained a kind-axis routing probe and a gotcha-prevents-rebug
  moat scenario.

### Fixed
All three code bugs below were found by Agentry's own adversarial bug-hunt and
fixed through its debug loop — each with a regression test proven to fail
without the fix.
- **memory:** an explicit `supersedes` was silently swallowed by the
  dedup-reinforce path when the new fact's text near-duplicated an active fact,
  leaving the retired fact active and winning recall (high severity — corrupted
  the memory moat).
- **eval:** the one-shot/degenerate disambiguator counted the harness's own
  bookkeeping (`stream.jsonl`, primer logs) written into the working dir, so a
  no-output run was mis-scored `one-shot` instead of rejected as degenerate.
- **check-plugin:** the dist-lockstep gate was blind to transitive
  `@agentry/*` workspace-dependency staleness — a `@agentry/core` change could
  leave the bundled MCP stale while the gate reported "up to date."
- **ci:** the install-free release job no longer fails on `setup-node`'s pnpm
  cache-save (`package-manager-cache: false`).

## [0.1.0] — 2026-06-17

### Added
- Initial release: an adaptive agentic layer for Claude Code.
  - **Right-sized orchestration** — a conductor that routes a task to the least
    process that wins (one-shot → spec-first → decompose+verify) and sequences
    specialist subagents end to end.
  - **SDLC roster** — architect, designer, explorer, implementer, librarian,
    product-owner, researcher, and verifier, each backed by a craft skill.
  - **Durable memory MCP** — recall of precedent and gotchas that compounds
    across sessions (the moat).
  - **Self-eval harness** — measures the system's own routing and decision
    quality instead of asserting it works.

[Unreleased]: https://github.com/Codestz/agentry/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/Codestz/agentry/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Codestz/agentry/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Codestz/agentry/releases/tag/v0.1.0
