// @ts-check
import { defineConfig } from 'astro/config';

// Static-first marketing site (VISION §2). Hosted on GitHub Pages under /agentry by default;
// `site`/`base` are env-overridable (ADR 004) so a custom domain is a one-line change at deploy time.
export default defineConfig({
  output: 'static',
  site: process.env.SITE_URL ?? 'https://codestz.github.io',
  base: process.env.BASE_PATH ?? '/agentry',
});
