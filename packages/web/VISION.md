# Agentry — public website · VISION & build brief

> This is the brief to dispatch via `/agentry:go`. It defines the **what / why / stack / design constraints**,
> not the implementation. It is intentionally self-contained: the design (screens, components, states) is for
> Agentry's `designer` to derive from the brand system and principles below, then verify against the rendered
> result. The brand system (§5) is a constraint; the visual design is an output.

---

## 1. North star

**Show the receipts.** Agentry's whole thesis is "measured, not asserted." The site must *embody* that:
lead with methodology and evidence (the corrections log, the controls, the reproducible self-eval), not with a
hero number and hype. An observatory, not a billboard. A skeptical senior engineer should leave thinking
"these people actually hold themselves to a bar," and be one copy-paste from installed.

Primary CTA: **install** (`/plugin marketplace add Codestz/agentry`). Secondary: **see the evidence** (the
real eval dashboard). Tertiary: **GitHub**.

Meta-proof: the site itself is built and conducted through `/agentry:go` — it is the dogfood showcase. The
footer says so, and it should be true.

---

## 2. Stack

| Concern | Choice | Why |
| :-- | :-- | :-- |
| Framework | **Astro** (latest) | Static-first, ships ~zero JS by default; islands only where we need them. Right altitude for a marketing site + embedded static dashboard. Not Next (no runtime needed), not raw Vite (we'd rebuild routing/content). |
| Language | **TypeScript** | Matches the repo bar; islands and helpers are typed. |
| Styling | **Plain CSS** via a single design-tokens stylesheet + scoped component styles | The token system (§5) is hand-CSS and small. No Tailwind/CSS-in-JS — keep deps minimal, keep the tokens as the single source of truth. |
| Interactivity | **Astro islands** (vanilla TS, `client:visible` / `client:idle`) | Only two genuinely interactive pieces (see §6). Everything else is static HTML. |
| Package manager | **pnpm** (workspace) | Already the repo standard (pnpm 11.7.0). `packages/*` is already globbed — no workspace change needed. |
| Node | **≥ 24** | Repo standard. |
| Hosting | **GitHub Pages** (static) via Actions | Zero extra accounts; repo is GitHub-centric. Upgrade path: Cloudflare Pages / Vercel for per-PR previews + edge (same static output, just repoint). |

### Location & workspace

- Lives at **`packages/web/`** — alongside `core`/`memory`/`eval`. This repo keeps all dev packages under
  `packages/` (e.g. `packages/eval` is a runnable harness, not a pure library), so a new top-level `apps/`
  would fight that precedent for no gain. **Not** in `plugin/` — the shipped payload stays lean (`source:"./plugin"`).
- `packages/*` is already in `pnpm-workspace.yaml` — no workspace change needed.
- Package name: `@agentry/web`, `"private": true` (never published to npm; it's a deployable, nothing imports it).
- Astro `base` set to `/agentry` for project-pages hosting (`codestz.github.io/agentry`); make it overridable
  via env so a custom domain (empty base) is a one-line change.

### Proposed structure (the architect refines)

```
packages/web/
  astro.config.mjs          # site, base, integrations
  package.json              # @agentry/web, scripts: dev/build/preview
  tsconfig.json
  public/
    dashboard/              # the latest eval dashboard, copied in at build (see §7)
    favicon / og image
  src/
    styles/tokens.css       # the :root design tokens (single source of truth — see §5)
    layouts/Base.astro      # <head>, nav, footer, fonts, meta/OG
    pages/index.astro       # the one landing page (sections composed here)
    components/             # static section components (.astro)
      Hero.astro  Why.astro  Pillars.astro  Moat.astro  Proof.astro  Install.astro
    islands/                # the only client-side TS
      ConstellationNet.ts   # animated canvas network (hero)
      RoutingDemo.ts        # tabbed right-sizing demo
      countUp.ts  reveal.ts # tiny shared motion helpers
```

---

## 3. Hosting & deploy

- **GitHub Pages** via a `deploy.yml` workflow, separate from the existing `ci.yml`/`release.yml`:
  - trigger: push to `main` touching `packages/web/**` (+ manual `workflow_dispatch`).
  - steps: checkout → pnpm → setup-node 24 → `pnpm --filter @agentry/web build` →
    `actions/upload-pages-artifact` (dist) → `actions/deploy-pages`.
  - `permissions: { pages: write, id-token: write }`; environment `github-pages`.
- Enable Pages → "GitHub Actions" source in repo settings (one-time, manual — note it in the PR).
- Don't break `release.yml`/`ci.yml`. The site build is independent of the plugin gate.

---

## 4. Information architecture (one page, scroll narrative)

Order is the argument — **claim → why → how → proof → install**:

1. **Nav** (sticky, blurs on scroll) — brand mark, anchors (Proof · How it works · Pillars · Install · GitHub), Install button.
2. **Hero** — "The agentic layer that **measures itself.**" Living constellation backdrop + aurora glow, lead, dual CTA, 3 count-up KPIs, a typing terminal showing `/agentry:go`.
3. **Why band** — "Dropping a powerful model on a hard task and *hoping* is not engineering." The thesis.
4. **Pillars** — brain (right-sized conductor) · memory (the moat) · harness (capability-first specialists). 2-col editorial split (sticky rail + stacked cards).
5. **How it works — routing demo** (interactive) — pick a task, watch it route to the *least process that wins* (one-shot → spec-first → decompose), with the reason and a trace.
6. **Moat** — same task, cold (spec-first) vs. warm (one-shot) once a decision is recalled. Memory compounds.
7. **Proof** — the centerpiece. Corrections log (times the meter was wrong and the conductor was right) + Controls (all passed) + the creed. Links to the live dashboard.
8. **Install** — 20-second copy-paste, Node ≥ 24 note.
9. **Footer** — "built with `/agentry:go` — conducted end-to-end."

Layout language: editorial **2-column split** (`0.82fr / 1.18fr`, sticky heading rail + content), generous
section padding (~150px), `max-width:1200px`. Collapses to 1 column < 900px. Breathing room over density — this
is an observatory, not a dashboard; don't crowd the sections.

---

## 5. Design system (single source of truth = `tokens.css`)

Observatory aesthetic: neutral near-black canvas, **violet = actions only**, **amber = brand spark**, semantic
data colors. Shared with the eval dashboard so the site and the receipts feel like one product.

```css
:root {
  --bg:#0b0b0f; --bg-2:#08080b; --panel:#14141a; --panel-2:#1c1c24; --line:#26262f; --line-soft:#1b1b21;
  --ink:#eaeaf0; --muted:#9a9aa7; --faint:#61616d;
  --amber:#f4a93c; --violet:#8b5cf6; --violet-2:#a78bfa; --violet-dim:rgba(139,92,246,.14);
  --good:#46c98a; --coral:#ef8a5c; --cyan:#56b6c2; --bad:#f0604d;
  --action:linear-gradient(135deg,#8b5cf6,#7c3aed);
  --brand:linear-gradient(120deg,#f4a93c,#ef8a5c 42%,#8b5cf6);
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
  --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
}
```

- **Color discipline:** violet is reserved for actions/CTAs and "warm/recalled" states; amber is the brand
  spark and headline gradient; green/coral/cyan/bad carry data meaning only. Don't decorate with semantic colors.
- **Type:** system sans for prose, mono for code/labels/telemetry. Headline gradient (`--brand`) animates a
  slow shimmer. Big confident hero (`clamp(42px,6.6vw,76px)`, weight ~840, tight tracking).
- **Motif:** the constellation node-graph (amber→violet) is the logo and the connective metaphor (orchestration
  = a network). Used as the animated hero canvas and as small seeded SVG marks in nav/footer.
- **Surfaces:** `--panel` cards, 1px `--line` borders, 14–18px radii; glass blur on floating elements (pills,
  KPIs, terminal) over the hero.

### Motion (this is part of the ask — "better hero + animations")

- **Hero is alive:** canvas constellation with drifting nodes, dynamic distance-based edges, and **mouse
  reactivity** (nodes gently repelled by cursor); radial edge mask; an aurora glow that slowly drifts.
- **Entrance:** staggered fade-up of hero elements (badges → headline → lead → CTA → KPIs → terminal).
- **Count-up** KPIs on first view (IntersectionObserver, easeOutCubic).
- **Typing terminal:** types the `/agentry:go` command, then reveals the routed output lines.
- **Scroll-reveal:** every section fades up on enter (IO + `.reveal/.in`), with small per-card stagger.
- **Micro-interactions:** card hover lift, CTA glow, animated `→` in the moat, blinking cursor.
- **Accessibility:** honor `prefers-reduced-motion: reduce` — disable all of the above and render a clean
  static page. Motion should feel intentional and calm (orchestration, not a screensaver), never janky; keep it
  off the critical render path.

---

## 6. Interactive islands (the only client JS)

1. **`ConstellationNet`** — the hero canvas network. Seeded/deterministic enough to look intentional;
   `requestAnimationFrame`, devicePixelRatio-aware, pauses when offscreen, respects reduced-motion. `client:load`
   (it's above the fold) or `client:idle`.
2. **`RoutingDemo`** — tabbed task picker → renders routed shape badge + rationale + trace. Pure data-driven
   from a typed `TASKS` array. `client:visible`.

Everything else (count-up, reveal, typing, copy button, nav-scroll) are tiny vanilla helpers, not frameworks.
Keep total shipped JS small — if a piece can be CSS-only, make it CSS-only.

---

## 7. The receipts — embed the real dashboard

The eval reporter (`packages/eval/src/report/`) already emits a static HTML dashboard from the run store. The
site's credibility hinges on linking to the **real** artifact, not a screenshot:

- Build step copies the latest generated dashboard into `packages/web/public/dashboard/`.
- "See the evidence" / the Proof section links there (new tab or embedded route).
- The corrections log + controls shown on the landing page should mirror the dashboard's real data where
  feasible (at minimum, not contradict it). Decide during planning whether to hand-author the landing summary
  or generate it from the same run store — prefer generating if cheap.

---

## 8. Voice & content principles

- **Measured, not hyped.** Every number carries its caveat (±, n, "to the labeled floor"). Never a bare boast.
- **Concrete over abstract.** Show a real routed task, a real correction, a real install command.
- **Honest about maturity.** v0.1, pre-1.0, MIT, "live." Don't oversell.
- Every metric must trace to the actual current eval run store before publishing — don't ship stale or
  invented numbers. If a number can't be sourced, don't show it.

---

## 9. Non-goals (v1)

- No backend, no auth, no DB, no analytics beyond (optionally) privacy-friendly page counts.
- No CMS — content lives in components/markdown in-repo.
- No blog/docs site yet (leave room; don't build it now).
- No multi-page routing beyond the landing page + the embedded dashboard.
- Don't touch `plugin/`, the memory MCP, or the eval harness internals — the site only *consumes* the
  dashboard output.

---

## 10. Acceptance criteria

- [ ] `packages/web` is an Astro + TS workspace package; `pnpm --filter @agentry/web build` produces a static `dist/`.
- [ ] `apps/*` added to `pnpm-workspace.yaml`; root install still clean; existing `ci.yml`/`release.yml` unaffected.
- [ ] The landing page realizes the IA (§4), brand system (§5), and motion (§5) as Astro components + islands —
      coherent, hierarchical, on-brand; verified against the rendered result (designer see-it loop), not asserted.
- [ ] Hero is animated (living constellation + aurora + staggered entrance + typing terminal + count-up KPIs);
      `prefers-reduced-motion` renders a clean static version.
- [ ] Routing demo and constellation work as islands with minimal shipped JS; Lighthouse perf is strong
      (target ≥ 95 perf, ≥ 95 a11y) on the built output.
- [ ] Design tokens live once in `tokens.css` and match §5 exactly; color discipline (violet=action,
      amber=brand, semantic=data) is respected.
- [ ] The eval dashboard is reachable from the site ("see the evidence") and copied into the build.
- [ ] `deploy.yml` builds and publishes `packages/web` to GitHub Pages on push to `main`; site loads at the Pages
      URL with `base:/agentry` correct (no broken asset paths).
- [ ] Responsive: 2-col splits collapse cleanly < 900px; readable on mobile.
- [ ] Footer claim ("built with `/agentry:go`") is true — the build was conducted through Agentry.

---

## 11. Reference

- **Brand/dashboard precedent:** `packages/eval/src/report/` (same token system, neutral-black canvas,
  violet=actions, amber=brand, semantic data colors) — the closest living example of the intended look.
- **Repo conventions:** root `CLAUDE.md` (the code bar, SRP, right-sizing), `.docs/internal/`.
