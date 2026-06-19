// Build @agentry/flow → a single committed, zero-install ESM bundle shipped INSIDE the plugin payload at
// `plugin/flow/index.js` (the path the manifest's flow MCP points at: `${CLAUDE_PLUGIN_ROOT}/flow/index.js`).
// The bundle lives in the plugin dir, not the package, so a marketplace install of `plugin/` carries the MCP.
//
// - No `external` — FLOW uses no runtime builtin like node:sqlite (ADR-001: text files are truth), so
//   nothing is left unbundled; the whole graph (incl. CJS deps yaml/zod) is inlined.
// - The createRequire banner lets esbuild's __require resolve real requires for bundled CommonJS
//   deps (e.g. `yaml`, `zod`) under ESM output — without it, their internal require() throws
//   "Dynamic require not supported" at startup.
import { writeFileSync } from "node:fs";
import { build } from "esbuild";
import { bundleSrcHash } from "../../scripts/lib/src-hash.mjs";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  outfile: "../../plugin/flow/index.js",
});

// Stamp the source content-hash next to the bundle so dist-lockstep is verifiable without mtimes. Covers this
// package's own src AND every @agentry/* workspace dep esbuild inlines (e.g. @agentry/core's dist) — so a
// transitive dep change can't leave the committed bundle stale while the gate reports green.
writeFileSync("../../plugin/flow/.srchash", bundleSrcHash("."));

console.log("built plugin/flow/index.js");
