---
title: cross-cutting design + a11y polish pass (the calm design law)
status: done
lockedBy: implementer
assignee: implementer
version: 852144d857f4d2f3
---

---
phase: 5
kind: chore
status: todo
deps: [22, 23, 24, 25, 13, 16, 18, 19]
parallel_safe_with: [26]
---

## Goal
A final cross-cutting design + accessibility polish pass over the whole app — visual consistency against the two prototypes, WCAG contrast, keyboard/focus, labels — closing the calm-design law (VISION §3, §11) before the AC10 live gate.

## Contract
- **owns:** cross-cutting polish edits to `packages/workbench/web/src/design-system/tokens.css` + shared primitives, and a11y/contrast fixes spanning routes (coordinate: this task touches shared design-system + makes *additive* a11y fixes; substantive per-page redesigns route back to the page's owning task).
- **exposes:** a consistent, accessible, calm UI across every page + the doc/graph surfaces.
- **must NOT touch:** server source; the *logic* of any page (only visual/a11y polish). If a fix needs structural change, file it to the owning task.

## Approach
- Inherit the designer craft (the `designing` skill) + the two prototypes (`design/prototype-app.html`, `prototype-document.html`) as the visual target. Designer see-it loop over every surface — no UI ships unseen (VISION §11).
- a11y: WCAG contrast on the dark near-monochrome palette, keyboard navigation (the graph, the drawer, the rail), focus order, labels on interactive controls.
- Consistency: the design-system primitives (task 10) applied uniformly; empty states are good states everywhere.
- Run AFTER the pages exist (deps) so it polishes the real, assembled UI — but BEFORE/alongside the AC10 live gate (parallel-safe with task 26, which is the behavioral verification).

## Acceptance
- The whole app is visually consistent with the prototypes; WCAG contrast met on the dark palette; keyboard/focus/labels pass an a11y audit.
- Designer confirms the rendered result across every page. Closes the design/a11y half of the Phase-5 polish.
