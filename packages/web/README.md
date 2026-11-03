# `@agentry/web` — Agentry's public site

A static [Astro](https://astro.build) site: the landing page and the `/docs` area. Private workspace
package: deployed, never published to npm, and nothing imports it.

## Develop

```sh
pnpm --filter @agentry/web dev        # local dev server (hot reload)
pnpm --filter @agentry/web build      # static build → dist/
pnpm --filter @agentry/web preview    # serve the built dist/ locally
pnpm --filter @agentry/web typecheck  # astro check
```

## Layout

- `src/pages/index.astro` composes the landing page, one component per section in
  `src/components/` (Hero, Harness, Lanes, Agents, Extensible, Scriptable, Day, BoardView, Memory,
  Guardrails, FieldLog, Install), with the shared Nav and Footer from `src/layouts/Base.astro`.
- `src/styles/tokens.css` holds every design token; `global.css` the base layer and shared
  primitives; `docs.css` the docs prose classes. Fonts: Bricolage Grotesque and JetBrains Mono.
- Internal links and assets go through `withBase()` (`src/lib/base.ts`), so the site also works
  under a sub-path.

## Search readiness

- `src/lib/site.ts` holds the shared facts (description, theme colour, icon version, install lines);
  `src/lib/jsonld.ts` builds the JSON-LD (home: `SoftwareApplication` + `WebSite`; docs:
  `BreadcrumbList`). Every page gets a canonical, `og:url` and `og:locale`; the 404 is `noindex`.
- `robots.txt` and `site.webmanifest` are endpoints in `src/pages/`; `@astrojs/sitemap` writes
  `sitemap-index.xml`; `integrations/llms.mjs` writes `llms.txt` and `llms-full.txt` from the built
  docs pages, so they cannot drift.
- The raster icons in `public/` come from the tape mark: `node scripts/make-icons.mjs` (needs
  `rsvg-convert`) re-renders them. Bump `ICON_VERSION` in `site.ts` when the mark changes.
- `vercel.json` sets trailing slashes, clean URLs, cache lengths and a few safe headers.

## Deploy

Vercel builds the site from the repo at `https://agentry.silentthreadstudio.com`. `site` and `base`
default to that domain and `/`; the `SITE_URL` and `BASE_PATH` environment variables override them
(for example, a preview under a sub-path). The base layout includes Vercel Analytics and Speed
Insights, which only report when served by Vercel.
