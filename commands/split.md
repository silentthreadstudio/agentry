---
description: Slice a Plan's architecture map into bounded Task contracts — parallel-safe, cold-resumable, with a coverage matrix. Prepares the build.
argument-hint: [plan id — optional if a plan exists]
---

Dispatch the **architect** subagent to split the plan into tasks (`$ARGUMENTS` if given; otherwise the active plan).

Brief for the architect (using the `planning` craft):
- Slice each component/seam on the architecture map into a Task with a **contract** (`owns` files + `exposes` interface).
- Set `deps` **only** where contracts overlap; everything else stays parallelizable.
- Pre-fill each task's **Gotchas** from recalled memory for its `owns` files; make **Acceptance** independently checkable; fill Background + Out-of-scope.
- Build the **criterion→task coverage matrix** — every Spec `AC` must trace to ≥1 task. Flag any uncovered criterion before the build.

Output: one Task file per unit (doc-01 frontmatter + body) under `.agentry/work/<id>-<slug>/tasks/`, plus the coverage matrix.
