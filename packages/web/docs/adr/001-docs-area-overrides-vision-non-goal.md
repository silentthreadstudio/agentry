---
kind: adr
id: 001
title: Add a multi-page /docs area to the public website, overriding VISION §9 non-goal
status: accepted
date: 2026-06-20
---

# ADR-001 — a `/docs` area overrides VISION §9 ("no docs site / no multi-page routing")

## Context

The approved Spec adds a five-page docs area under `packages/web/src/pages/docs/` (overview +
flow/memory/workbench/channels), a shared docs sub-nav, diagram panels, and a "Docs" link in the
site nav. This is a **direct, named contradiction** of the site's own vision doc:

- `packages/web/VISION.md` **§9 Non-goals (v1)** — *"No blog/docs site yet (leave room; don't build
  it now)."* and *"No multi-page routing beyond the landing page + the embedded dashboard."*

The `architecting` skill's consistency rule is explicit: a change that conflicts with an established
written convention is **itself an ADR-worthy fork** — it must be surfaced and recorded, not landed
silently. Building five routed pages while VISION still says "don't" would leave the repo's own
charter contradicting its shipped reality. So the decision to override is the load-bearing decision
of this work, and it is recorded here.

Repo ground truth that bears on the choice (verified, not assumed):

- The framework choice **already supports this for free.** `astro.config.mjs` is `output: 'static'`
  with `base: '/agentry'`; Astro's file-based routing turns `src/pages/docs/*.astro` into static
  routes with **zero new dependency, no runtime, no router** — exactly the "right altitude" VISION
  §2 picked Astro for. The non-goal was a *scope* boundary ("don't build it yet"), not a *technical* one.
- The product has **grown four real subsystems** (FLOW, Memory, Workbench, Channels) since the
  landing page was written — each now has a shipped diagram (`public/diagrams/`) and a story
  (mandatory substrate vs. additive layers, with a degradation narrative). The landing page can
  *claim* these; it cannot *explain* them without becoming a god-page. A docs area is the right home
  for depth the landing page should not carry.

## Decision

**Add the multi-page `/docs` area as specified, and amend VISION §9/§10 to match the shipped
reality.** The override is deliberate and recorded; the vision doc stops being a non-goal for docs
and instead documents the docs area as in-scope, so the charter and the build agree.

Concretely:

- `src/pages/docs/index.astro` + four concept pages become **first-class static routes** under
  `base:/agentry` — consistent with §2 (static-first, file-routing, zero new deps).
- VISION **§9** loses the two docs/multi-page non-goal bullets; VISION **§10** gains an acceptance
  bullet for the docs area (five routes build, base-path-correct, on-brand, responsive).
- The landing page is **untouched** except for one added nav link — the docs area is **additive**,
  never a rewrite of the landing IA (§4).

## Alternatives

- **Keep §9 as-is; cram the four subsystem stories into the landing page.** Rejected: it turns the
  single landing page into a god-page carrying claim + why + how + proof + install **plus** four
  deep-dive narratives with diagrams — the SRP violation the code bar forbids, and it buries the
  install CTA under reference content. The landing page's job is to *convince*; docs' job is to
  *explain*. Different reasons to change → different pages.
- **A single long `/docs` page (anchors, not routes).** Rejected: one page with five diagrams is the
  god-file in page form; loses the per-page sub-nav, hurts focus and shareability (`/docs/flow` is a
  linkable concept), and still violates the *spirit* of §9 while contorting to honor its letter.
- **External docs (a separate site / Starlight).** Rejected: a second build, a new dependency, and a
  second deploy for five pages — over-engineering against VISION §2's "keep deps minimal."

## Consequences

- **Good:** the four subsystems get a home that explains them with their diagrams and the
  mandatory-vs-additive layering story, without distorting the landing page. Each `/docs/<x>` is a
  shareable, focused page.
- **Good:** zero new dependency or framework — pure Astro file-routing in the existing token system.
- **Cost / obligation:** VISION §9/§10 **must** be amended in the same body of work, or the charter
  contradicts the shipped site. (Done — §9/§10 updated, citing this ADR.)
- **Cost / the recurring trap:** every internal `href`/`img src` on a `/docs/*` route must go through
  `withBase()` (or be a bare `#fragment` to a section on the SAME page). The landing nav's anchors
  (`#proof`, `#how`, `#install`) are landing-only — from `/docs/*` a bare `#install` resolves to
  nothing. Any docs→landing-section link must be `withBase("") + "#anchor"`. This is the #1
  GH-Pages 404 trap. (The shared Nav/Footer anchors were made base-aware as part of this work.)

## Links

- `packages/web/VISION.md` §2, §4, §5, §9 (overridden), §10 (amended)
- `packages/web/astro.config.mjs` (`output:'static'`, `base:'/agentry'`)
- `packages/web/src/lib/base.ts` (`withBase()` — the base-path discipline this ADR's consequences hinge on)
