---
name: designing
description: This skill should be used when designing or fixing a user interface — establishing visual hierarchy, layout and spacing, typography, color and contrast, accessibility (WCAG contrast, keyboard, focus, labels), responsive behavior, interaction states, or consistency with an existing design system, and verifying the rendered result. Loaded for UI/UX and product-design work, not for backend or non-visual tasks.
version: 0.1.0
---

# Designing

Design interfaces that are **coherent, accessible, and consistent with the system already in the repo** — then **see them rendered** before calling them done. The failure this craft exists to prevent: functional-but-ugly UIs with no hierarchy, clashing styles, unreadable contrast, and broken keyboard access. A UI you have not looked at is not finished.

## The two rules that govern every design

1. **Conduct existing design skills — don't reinvent.** Discover the design intelligence the user already has and orchestrate it rather than hand-rolling aesthetics. Hand-roll only when nothing relevant is installed (see *Conduct, don't reinvent*).
2. **See it before it's done.** Render → screenshot → read back → check. Verify the rendered pixels and behavior, never the source's intent. No browser tool → the work is **UNVERIFIED**; flag it and ask the human (see *The see-it loop*).

## Method

Work in this order; stop early when the change is small enough not to need later steps — but never skip the see-it loop on anything visible.

1. **Restate** what the UI must let the user do, and what "looks/works right" means here. If that can't be stated, design is blocked — get product clarity first. This stop is **pre-flight AND mid-flight**: if a design decision turns out to hinge on an **undecided product or IA fork** (which flow wins, what a concept is called, what's in the view) — whether you see it up front or hit it deep in the comp — **surface that fork**, don't quietly pick one inside the design and ship it as settled.
2. **Detect capabilities.** Which design skills are installed; whether a browser MCP is available to render and inspect.
3. **Read the existing design system.** Tokens (color, spacing, radius, shadow), type scale, component library, theme/dark-mode, breakpoints, and the conventions in force. Build *with* these — consistency beats novelty.
4. **Design** by conducting the best available skill(s): visual hierarchy, layout/spacing, typography, color/contrast, responsive behavior, and every interaction state.
5. **See it.** Run the see-it loop until it passes.
6. **Review.** Record what was checked, the method/screenshots, and the a11y result.

## The see-it loop (the verification step — non-negotiable)

The discipline that separates a designed UI from a guessed one:

1. **Render** — get the UI running and navigate to the surface. Prefer a browser MCP if present (chrome-devtools / claude-in-chrome).
2. **Screenshot** — capture the actual rendered state (and key responsive widths).
3. **Read back** — actually look at the screenshot. Check hierarchy, alignment, spacing rhythm, contrast, truncation/overflow, and that the right thing draws the eye first.
4. **Check behavior** — exercise keyboard navigation, focus order and visible focus rings, hover/active/disabled/loading/empty/error states.
5. **Iterate** until it passes; then capture the final proof.

If **no browser MCP is present**, you cannot assert correctness. Mark the work **UNVERIFIED**, state exactly which surfaces went unseen, deliver the design with that caveat, and ask the human to look or enable a browser tool. Calling UI done unseen is the cardinal failure.

## Conduct, don't reinvent

Detect what the environment offers and orchestrate it — these carry style systems, palettes, component specs, and review checklists better than improvisation:

- **Style/UX intelligence** — e.g. `ui-ux-pro-max` (styles, palettes, font pairings, UX guidelines), `frontend-design` (distinctive, non-generic UI).
- **Design system / tokens** — e.g. `ckm-design-system`, `ckm-ui-styling` (tokens, shadcn/Tailwind, accessible components).
- **Component libraries** — e.g. `shadcn` (registry components, presets), the repo's own component set.
- **Review/audit** — e.g. `web-design-guidelines` (Web Interface Guidelines / a11y review).

Pick the right one for the job and conduct it. Hand-roll from the principles below only when nothing relevant is available — and note that a design skill would raise quality.

## The principles (what "coherent and accessible" means)

- **Visual hierarchy** — one clear focal point per view; size, weight, color, and spacing direct attention in priority order.
- **Layout & spacing** — a consistent spacing scale (not arbitrary px); align to a grid; use whitespace to group and separate; respect rhythm.
- **Typography** — a small, intentional type scale; limited weights; readable line length and line-height; a coherent font pairing.
- **Color & contrast** — a restrained palette from the system's tokens; semantic color (success/warn/error) used consistently; **never** rely on color alone to convey meaning.
- **Accessibility (a requirement, not polish)** — WCAG contrast (≥ 4.5:1 body text, ≥ 3:1 large text/UI), full keyboard operability with no traps, logical focus order with a visible focus indicator, labels/roles/alt text, and adequate hit-target sizing.
- **Responsive** — design the real breakpoints; check reflow, wrapping, and touch targets at mobile width, not just desktop.
- **Interaction states** — every interactive element gets hover/focus/active/disabled, and views get loading/empty/error — designed, not defaulted.
- **Consistency** — reuse the repo's tokens and components; a foreign visual language is design convention drift. See `references/design-system-and-a11y.md`.

## Anti-patterns (refuse these)

- **Shipping UI unseen** — no see-it loop; can't see it → UNVERIFIED.
- **Poor contrast / no a11y** — low-contrast text, no focus states, keyboard traps, missing labels.
- **Engineer-aesthetics** — inconsistent spacing, no hierarchy, default-everything, clashing components.
- **Ignoring the existing design system** — inventing new styles instead of building with the repo's tokens/components.
- **Reinventing** — hand-rolling when a capable design skill is installed.
- **Over-design** — adding visual flourish, animation, or novel patterns the task never asked for; a button tweak doesn't earn a redesign. Match the scope of the ask, not the urge to restyle. The symmetric twin of under-accessibility: gold-plating the visual while inventing scope.

## Output

The designed UI (or specific changes) built on the repo's design system, plus a **design review**: what was checked, the **method and screenshots** from the see-it loop, and the **accessibility result** — or a clear **UNVERIFIED** flag with what's unseen. Report any memory (tokens, prior decisions) that shaped the design in `used_memories`.

## Additional resources

### Reference files
- **`references/design-system-and-a11y.md`** — design-token layers and consistency, the WCAG accessibility checklist (contrast, keyboard, focus, labels), responsive breakpoints, and the see-it-loop verification checklist.
