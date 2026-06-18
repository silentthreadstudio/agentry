# `@agentry/web` — Agentry's public marketing site

A static [Astro](https://astro.build) one-pager — the "show the receipts" observatory that leads with
methodology and evidence (the corrections log, the controls, the reproducible self-eval), embeds the **real**
eval dashboard, and is one copy-paste from installed. See [`VISION.md`](./VISION.md) for the full brief.

Private workspace package: a deployable, never published to npm — nothing imports it.

## Develop

```sh
pnpm --filter @agentry/web dev        # local dev server (hot reload)
pnpm --filter @agentry/web build      # static build → dist/
pnpm --filter @agentry/web preview    # serve the built dist/ locally
pnpm --filter @agentry/web typecheck  # astro check
```

`build` runs a `prebuild` data step first (load metrics + embed the dashboard). Those scripts live in
`scripts/` and only run when present, so the package builds cleanly while they're still being built.

## Deploy

Static output (`dist/`) ships to **GitHub Pages** via a dedicated `deploy.yml` workflow (push to `main`
touching `packages/web/**`). `site`/`base` are env-overridable (`SITE_URL` / `BASE_PATH`) — defaults target
`https://codestz.github.io/agentry`, so moving to a custom domain is a one-line change.

## Provenance

This site was built and conducted end-to-end through **`/agentry:go`** — the dogfood showcase. The thesis is
"measured, not asserted," and the footer says so because it's true.
