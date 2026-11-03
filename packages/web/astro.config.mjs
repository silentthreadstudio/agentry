// @ts-check
import { defineConfig } from "astro/config";

// Static site, hosted on Vercel at agentry.silentthreadstudio.com. SITE_URL / BASE_PATH override
// the defaults (e.g. a preview under a sub-path); an empty value falls back to the default.
export default defineConfig({
  output: "static",
  site: process.env.SITE_URL || "https://agentry.silentthreadstudio.com",
  base: process.env.BASE_PATH || "/",
  // Every page is a directory with a canonical ending in "/"; links must match it.
  trailingSlash: "always",
});
