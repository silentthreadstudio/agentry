<!-- Generated from plugin/commands/split.md by scripts/build-opencode.mjs — edit the source, not this file. -->
---
description: Slice a Plan's architecture map into bounded Task contracts — parallel-safe, cold-resumable, with a coverage matrix. Prepares the build.
---

Dispatch the **architect** subagent to split the plan into tasks (`$ARGUMENTS` if given; otherwise the active plan).

Brief for the architect (using the `planning` craft):
- Slice each component/seam on the architecture map into a Task with a **contract** (`owns` files + `exposes` interface + `excludes` must-not-touch). Pin exact names on any surface a sibling consumes; give each task its leave-it-green verify/build steps (discovered from the repo, not hardcoded).
- Set `deps` **only** where contracts overlap; everything else stays parallelizable.
- Pre-fill each task's **Gotchas** from recalled memory for its `owns` files; make **Acceptance** independently checkable; fill Background + Out-of-scope.
- Build the **criterion→task coverage matrix** — every Spec `AC` must trace to ≥1 task. Flag any uncovered criterion before the build.

Output: one Task per unit, written as a plain file `.agentry/work/<run>/tasks/NNN-slug.md` — exactly one frontmatter block (`title`, `status: todo`), then the contract/Gotchas/Acceptance sections as markdown (the canonical task file is in the `planning` skill) — plus the coverage matrix in `.agentry/work/<run>/coverage.md` (at the run root, not in `tasks/`, which holds task files only).
