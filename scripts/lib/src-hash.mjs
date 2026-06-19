// Deterministic content hash of a source tree — the dist-lockstep signal.
//
// mtimes are not preserved by git (a clone / checkout / squash-merge rewrites them), so comparing
// dist-vs-src mtimes yields false "dist is stale" warnings. Hashing file *contents* is checkout-proof:
// build.mjs stamps this hash into the committed dist, and check-plugin recomputes + compares it.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// SHA-256 over every file's POSIX-normalized relative path + its bytes, in sorted path order.
// Path order makes it stable across filesystems; including the path catches renames/moves.
export function srcHash(srcDir) {
  const files = readdirSync(srcDir, { recursive: true })
    .map((f) => join(srcDir, String(f)))
    .filter((p) => statSync(p).isFile())
    .map((p) => relative(srcDir, p).split(sep).join("/"))
    .sort();
  const h = createHash("sha256");
  for (const rel of files) {
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(join(srcDir, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

// The dist-lockstep signal for a BUNDLED package (e.g. @agentry/memory → plugin/mem/index.js).
//
// `srcHash(pkg/src)` alone is BLIND to transitive staleness: esbuild inlines the package's workspace
// dependencies, so a change in a dep (e.g. @agentry/core) leaves the bundle stale while the own-src hash is
// unchanged and the gate reports "up to date" (the v0.2 `kind`-enum drift was exactly this). This hashes the
// package's OWN src PLUS the `src` of each `@agentry/* workspace:*` dependency, auto-discovered from
// package.json (so a future workspace dep is covered without editing this).
//
// We hash each dep's `src` (git-TRACKED), not its built `dist` entry that esbuild actually inlines: `dist` is a
// gitignored build artifact, so hashing it would make the signal depend on local build state — a fresh clone
// (no `dist`) would hash differently than a post-build tree and trip a false "stale". `src` is the stable,
// tracked source of truth: if a dep's src changed, the committed bundle must be rebuilt. (Third-party deps are
// pinned by the lockfile and remain out of scope — the proven gap is workspace deps.)
//
// `opts` is ADDITIVE — `bundleSrcHash(pkgDir)` with no opts is byte-identical to before (the mem/flow path):
//   - `srcSubdir` (string, default "src"): the package-relative path of the source root to hash as "self".
//       Lets one package expose more than one buildable source root — e.g. the workbench has `web/src` and
//       `server/src` under a single `packages/workbench/` (pass `{ srcSubdir: "web/src" }` /
//       `{ srcSubdir: "server/src" }`). `pkgDir` stays the package root: it is BOTH the home of the
//       `package.json` whose `@agentry/* workspace:*` deps are walked AND the anchor whose `..` is the
//       resolution base for those deps (so the server case must pass `pkgDir = packages/workbench` for
//       `@agentry/flow` to resolve to `packages/flow/src`, not `packages/workbench/flow/src`).
//   - `skipWorkspaceDeps` (boolean, default false): when true, hash ONLY the `srcSubdir` root and do NOT walk
//       workspace deps — for a source root with no `@agentry/*` workspace dependency (e.g. the web UI, whose
//       third-party deps Vite bundles into static assets). The server root keeps the walk (default false) so a
//       transitive `@agentry/flow/src` change still marks its bundle stale.
export function bundleSrcHash(pkgDir, opts = {}) {
  const { srcSubdir = "src", skipWorkspaceDeps = false } = opts;
  const packagesDir = join(pkgDir, "..");
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  // [label, srcDir] pairs: the package's own src, then each @agentry/* workspace dep's src.
  const inputs = [["self", join(pkgDir, srcSubdir)]];
  if (!skipWorkspaceDeps) {
    for (const [name, ver] of Object.entries(pkg.dependencies ?? {})) {
      if (typeof ver !== "string" || !ver.startsWith("workspace:") || !name.startsWith("@agentry/")) continue;
      const depSrc = join(packagesDir, name.slice("@agentry/".length), "src");
      if (existsSync(depSrc)) inputs.push([name, depSrc]);
    }
  }
  inputs.sort((a, b) => (a[0] < b[0] ? -1 : 1)); // stable order, independent of package.json key order
  const h = createHash("sha256");
  for (const [label, dir] of inputs) {
    h.update(label);
    h.update("\0");
    h.update(srcHash(dir));
    h.update("\0");
  }
  return h.digest("hex");
}
