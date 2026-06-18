# Design System, Accessibility & the See-it Loop — depth

Reference for the `designing` skill: how to stay consistent with an existing system, the accessibility bar to meet, and the verification checklist that closes the see-it loop. Apply these to the depth the work earns — a button tweak needs the contrast + state checks, a new surface needs all of it.

## Consistency with the existing design system

**Default: build with what's there.** Before styling anything, read how the repo expresses design, and reuse it. A plain-but-consistent UI beats a clever-but-foreign one. Introduce a new visual pattern only when none exists, and flag it as a new convention for the conductor.

What to read first:
- **Design tokens** — color, spacing, radius, shadow, z-index, motion. Usually CSS variables, a Tailwind config, or a theme object.
- **Type scale** — the defined font sizes/weights/line-heights and the font pairing. Use the scale; don't introduce off-scale sizes.
- **Spacing scale** — the spacing steps (e.g. 4/8-based). Use steps, never arbitrary pixel values.
- **Component library** — the existing components (e.g. shadcn/ui, an in-house set). Compose from them before building new ones.
- **Theme** — light/dark support and how it's toggled; design for both if the system has both.

**Token layering (when shaping or extending a system):** primitive (raw values) → semantic (`color.bg.surface`, `space.md`) → component (`button.padding`). Reference semantic tokens in UI, not raw primitives, so theming and rebrands stay cheap. Conduct an installed design-system skill (e.g. `ckm-design-system`) for this rather than hand-rolling.

## Accessibility checklist (a requirement, not polish)

Meet WCAG 2.1 AA as the floor.

**Contrast**
- Body text ≥ **4.5:1** against its background.
- Large text (≥ 24px, or ≥ 19px bold) and meaningful UI/graphics ≥ **3:1**.
- Check the *rendered* contrast (states, overlays, images behind text) — not just the token values.
- **Never convey meaning by color alone** — pair color with text, icon, or pattern (e.g. error = red *and* an icon *and* a message).

**Keyboard**
- Everything operable by mouse is operable by keyboard (Tab/Shift-Tab/Enter/Space/Esc/arrows as appropriate).
- **No keyboard traps** — focus can always move out of any component (modals included).
- Logical **focus order** that follows visual reading order.
- A **visible focus indicator** on every focusable element — never `outline: none` without a replacement.
- Modals/menus: trap focus *while open*, return focus to the trigger on close, Esc closes.

**Semantics & labels**
- Use native semantic elements (`button`, `a`, `nav`, `main`, headings in order) before ARIA.
- Every control has an accessible name (visible label, `aria-label`, or `aria-labelledby`).
- Images: meaningful `alt`; decorative images `alt=""`.
- Form fields: associated `<label>`; errors announced and tied to the field.

**Targets & motion**
- Touch targets ≥ ~44×44px with adequate spacing.
- Respect `prefers-reduced-motion`; don't rely on animation to convey state.

Conduct `web-design-guidelines` (Web Interface Guidelines review) or `ui-ux-pro-max` a11y guidance if installed to audit against a fuller checklist.

## Responsive behavior

- Design the **real breakpoints**, not just desktop. Check the smallest supported width.
- Verify reflow: no horizontal scroll, no clipped/overlapping content, readable line length.
- Check wrapping, truncation (with accessible full text), and that touch targets stay large enough on mobile.
- Test the rendered layout at each breakpoint in the see-it loop — don't infer it from CSS.

## Interaction & content states

Design these explicitly; defaulting them is the engineer-aesthetics tell:
- **Element states** — hover, focus, active, disabled (and selected/checked where relevant).
- **View states** — loading (skeleton/spinner), empty (helpful, not blank), error (clear recovery), and the populated/success state.

## The see-it loop — verification checklist

Render → screenshot → read back → check. With a browser MCP (chrome-devtools / claude-in-chrome):

1. **Render** — navigate to the running surface.
2. **Screenshot** — capture the rendered state; repeat at key responsive widths and in dark mode if supported.
3. **Read back the screenshot** and check:
   - Hierarchy — does the right thing draw the eye first?
   - Alignment — to a grid; no off-by-a-few drift.
   - Spacing — consistent rhythm; nothing cramped or floating.
   - Contrast — text and UI legible against their actual backgrounds.
   - Overflow/truncation — nothing clipped or overlapping; long content handled.
4. **Exercise behavior** — Tab through: focus order logical, focus rings visible, no traps; hover/active/disabled render; loading/empty/error states display.
5. **Iterate** until it passes, then capture the **final proof screenshot**.

**No browser MCP present:** you cannot complete this loop. Mark the work **UNVERIFIED**, list the exact unseen surfaces, deliver the design with that caveat, and ask the human to view it or enable a browser tool. A screenshot tool that emulates devices/throttling (and a Lighthouse/a11y audit, if available) strengthens the loop — use it when present.

## What the review returns

A design review the conductor can trust without re-checking:
- **Checked** — hierarchy, layout/spacing, typography, color/contrast, responsive, states (the list above).
- **Method** — how it was rendered and the screenshots taken (the proof).
- **A11y result** — contrast ratios, keyboard/focus outcome, labels/semantics.
- **Residual risks / UNVERIFIED** — anything not confirmable, and why.
