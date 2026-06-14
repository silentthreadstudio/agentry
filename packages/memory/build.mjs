// Build @agentry/memory → a single committed, zero-install ESM bundle (dist/index.js).
//
// - node:sqlite stays EXTERNAL (it's a runtime builtin, not bundled).
// - The createRequire banner lets esbuild's __require resolve real requires for bundled CommonJS
//   deps (e.g. `yaml`) under ESM output — without it, their internal require() throws
//   "Dynamic require not supported" at startup.
import { build } from "esbuild";

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
  outfile: "dist/index.js",
});

console.log("built dist/index.js");
