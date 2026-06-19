// Build @agentry/workbench-server → a single committed, zero-install ESM bundle shipped INSIDE the plugin
// payload at `plugin/workbench/server/index.js` (the entry the /agentry:workbench command spawns). The bundle
// lives in the plugin dir, not the package, so a marketplace install of `plugin/` carries the server with it.
//
// - node:* builtins stay EXTERNAL (node:http here; node:sqlite once Phase 1 adds the derived index) — they're
//   runtime builtins, not bundled.
// - The createRequire banner lets esbuild's __require resolve real requires for any bundled CommonJS deps
//   under ESM output — without it, their internal require() throws "Dynamic require not supported" at startup.
//   (Mirrors packages/memory/build.mjs + packages/flow/build.mjs byte-for-byte in shape; ADR-003.)
import { writeFileSync } from "node:fs";
import { build } from "esbuild";
import { bundleSrcHash } from "../../../scripts/lib/src-hash.mjs";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["node:sqlite"],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  outfile: "../../../plugin/workbench/server/index.js",
});

// Stamp the source content-hash next to the bundle so dist-lockstep is verifiable without mtimes. The
// workbench is a multi-root package: `pkgDir` stays the package root (packages/workbench — home of the
// package.json whose @agentry/* workspace:* deps are walked, AND the `..` anchor that resolves @agentry/flow
// to packages/flow/src), while `srcSubdir` selects this server root. The walk picks up @agentry/flow/src
// transitively, so a flow src change marks the committed server bundle stale (task 2's extended bundleSrcHash).
writeFileSync(
  "../../../plugin/workbench/server/.srchash",
  bundleSrcHash("..", { srcSubdir: "server/src" }),
);

console.log("built plugin/workbench/server/index.js");
