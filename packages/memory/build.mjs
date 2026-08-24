// Build @agentry/memory → a single committed, zero-install ESM bundle shipped INSIDE the plugin payload at
// `plugin/mem/index.js` (the path the manifest's mem MCP points at: `${CLAUDE_PLUGIN_ROOT}/mem/index.js`). The
// bundle lives in the plugin dir, not the package, so a marketplace install of `plugin/` carries the MCP with it.
//
// - node:sqlite stays EXTERNAL (it's a runtime builtin, not bundled).
// - The createRequire banner lets esbuild's __require resolve real requires for bundled CommonJS
//   deps (e.g. `yaml`) under ESM output — without it, their internal require() throws
//   "Dynamic require not supported" at startup.
import { build } from "esbuild";
import { writeStamp } from "../../scripts/lib/src-hash.mjs";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["node:sqlite"],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  outfile: "../../plugin/mem/index.js",
});

// Stamp next to the bundle so dist-lockstep is verifiable without mtimes. Two hashes: the SOURCE hash (this
// package's own src AND every @agentry/* workspace dep esbuild inlines, so a transitive dep change can't leave
// the committed bundle stale while the gate reports green) and the hash of the just-written bundle bytes, so a
// stamp committed without its rebuilt bundle can't read green either. Must run AFTER build().
writeStamp("../../plugin/mem/.srchash", ".");

console.log("built plugin/mem/index.js");
