---
title: bundleSrcHash gains additive srcSubdir support (scripts/lib/src-hash.mjs)
status: done
lockedBy: implementer
assignee: implementer
version: dfec20168419a2be
---

---
phase: 0
kind: build
status: todo
deps: []
parallel_safe_with: [1, 3, 4, 5]
---

## Goal
Extend `bundleSrcHash` with additive `srcSubdir` (and/or explicit-src-path + skip-workspace-walk) support so it can hash `web/src` (no workspace deps) and `server/src` (+ transitive `@agentry/flow/src`) — keeping the existing mem/flow callers byte-identical (ADR-003).

## Contract
- **owns:** `scripts/lib/src-hash.mjs`
- **exposes:** an extended `bundleSrcHash(pkgDir, opts?)` signature where `opts.srcSubdir` selects a non-`src` source root and a way to skip the workspace-dep walk when there is none. Pin: the exact param name/shape the Phase-0 `check-plugin` task (task 4) and the build tasks (server `build.mjs`, task 3) will call. Default behavior (no opts) is unchanged.
- **must NOT touch:** `scripts/check-plugin.mjs` (task 4 owns it), any `packages/` source.

## Approach
- Read `scripts/lib/src-hash.mjs` first; the change is **additive only** (ADR-003 alt 4 — keep dist-lockstep logic in one place, no wrapper). Recall: the content-hash uses `dist/.srchash` content (memory: dist-lockstep is content-hash based), and the transitive-dep walk already exists — preserve it for the server case, allow opting out for the web case.
- Verify-and-adjust, do not assume: read the current signature and the two existing callers (mem/flow build.mjs) so the default path stays identical.

## Acceptance
- The two existing mem/flow `bundleSrcHash` callers produce **identical** hashes to before (regression: `node scripts/check-plugin.mjs` still green on mem/flow rows after the change, with no workbench artifacts yet present they should be untouched).
- New `srcSubdir` path hashes `web/src` without walking workspace deps, and `server/src` *with* `@agentry/flow/src` coverage.
- Advances AC9 (the lockstep machinery). Verifier proves it by hashing a known src tree and confirming mem/flow rows unchanged.
