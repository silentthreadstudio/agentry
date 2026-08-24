// Deterministic content hash of a source tree — the dist-lockstep signal.
//
// mtimes are not preserved by git (a clone / checkout / squash-merge rewrites them), so comparing
// dist-vs-src mtimes yields false "dist is stale" warnings. Hashing file *contents* is checkout-proof:
// build.mjs stamps the hashes into the committed dist (`writeStamp`), and check-plugin recomputes + compares.
//
// The stamp carries TWO hashes, and they answer two different questions:
//   - `src`  (`bundleSrcHash`) — "has the source moved since this bundle was built?"
//   - `dist` (`distHash`)      — "are the committed bundle bytes the ones this stamp was taken over?"
// A src-only stamp cannot tell a rebuilt-and-committed bundle from a `.srchash` committed WITHOUT its
// rebuilt bundle (partial stage, a revert that took only the bundle, a hand-edit) — both sides described
// the source, so nothing read the artifact being certified. Observed live on plugin/mem/index.js (2026-08-24):
// 26 lines behind its source, gate green.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, lstatSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

// SHA-256 over every file's POSIX-normalized relative path + its bytes, in sorted path order.
// Path order makes it stable across filesystems; including the path catches renames/moves.
// `exclude` is a list of POSIX-relative paths to skip — used only by `distHash` (see below); the src side
// passes none, so its digest is byte-identical to before.
export function srcHash(srcDir, { exclude = [] } = {}) {
  const skip = new Set(exclude);
  const files = readdirSync(srcDir, { recursive: true })
    .map((f) => join(srcDir, String(f)))
    // lstat, not stat: a DANGLING symlink makes stat throw, and a hashing helper that throws takes the
    // whole gate down with a stack trace instead of reporting a row. lstat describes the link itself, so a
    // broken one is simply not a file and is skipped.
    .filter((p) => lstatSync(p).isFile())
    .map((p) => relative(srcDir, p).split(sep).join("/"))
    .filter((rel) => !skip.has(rel))
    .sort();
  return hashFiles(srcDir, files);
}

// The digest itself, over an ALREADY-SELECTED, already-sorted file list. Both hashers share it so the two
// selection strategies (walk the filesystem / ask git) can never drift in how they combine what they found.
//
// Each file contributes its length-prefixed relative path and its length-prefixed bytes. The lengths are
// what make the framing unambiguous: concatenating `path \0 bytes \0` lets a NUL inside a file imitate a
// record boundary, so two different trees can collide. Paths are included (not just contents) so a rename
// or a move registers as a change.
function hashFiles(rootDir, relPaths) {
  const h = createHash("sha256");
  for (const rel of relPaths) {
    h.update(`${Buffer.byteLength(rel)}:${rel}\n`);
    // A listed path that cannot be READ is a real state, not an impossible one: git lists a tracked file
    // that has been deleted from disk, and a dangling symlink is listed as untracked-but-not-ignored.
    // Both MUST change the digest — a deleted bundle file is exactly the drift this gate exists to catch —
    // but neither may throw, because a hashing helper that throws takes the whole gate down with a stack
    // trace and the remaining checks never run. So an unreadable path contributes a distinct absent marker.
    // The marker cannot be imitated by real content: readable files are framed by a byte length, and a
    // length is always digits.
    let bytes;
    try {
      bytes = readFileSync(join(rootDir, rel));
    } catch {
      h.update("absent:");
      continue;
    }
    h.update(`${bytes.length}:`);
    h.update(bytes);
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

// The stamp file, written next to the bundle it certifies.
const STAMP_FILE = ".srchash";
const STAMP_VERSION = 2;

// Content hash of a COMMITTED plugin bundle — the other half of the lockstep signal.
//
// Note the deliberate asymmetry with `bundleSrcHash`, which hashes each workspace dep's `src` and explicitly
// NOT its `dist`: a dep's `dist` is a gitignored, locally-built artifact, so hashing it would make the signal
// depend on local build state. The plugin bundle here is the opposite kind of file — it is COMMITTED payload,
// present and identical in every checkout, so hashing its bytes is as checkout-proof as hashing src. That is
// exactly why it can be verified, and why leaving it unverified was the hole.
//
// Hashes the whole dist DIRECTORY, not a single entry file, because one bundle is not always one file:
// plugin/mem, plugin/flow and plugin/workbench/server are a lone `index.js`, but plugin/workbench/web is Vite
// output whose asset filenames are themselves content-hashed and change every build. A directory hash covers
// both shapes with one code path (and catches a stray or deleted sibling file too). `.srchash` is excluded —
// it cannot contain a hash of a file that contains it.
//
// It hashes WHAT GIT WOULD SHIP, not what happens to sit on disk, and that distinction is load-bearing. A
// raw filesystem walk means any stray file in the directory changes the digest — and on macOS, merely
// opening the folder in Finder creates `.DS_Store`, which this repo GITIGNORES. That produced a gate that
// hard-failed a git-clean tree, and whose obvious remedy was worse than the symptom: rebuilding re-stamps
// over the stray file, so a machine-local ignored artifact gets baked into a committed stamp that then
// fails for everyone else. `--cached --others --exclude-standard` is exactly the right set: tracked files
// PLUS new build output not yet added (so a fresh Vite asset is covered the moment it is written), MINUS
// anything gitignored.
//
// Falls back to the raw walk outside a work tree — a tarball, a vendored copy — where "what git would
// ship" has no answer and the files present are the best available truth.
export function distHash(distDir) {
  const tracked = shippedFiles(distDir);
  return tracked === null ? srcHash(distDir, { exclude: [STAMP_FILE] }) : hashFiles(distDir, tracked);
}

// The dist-relative paths git would include, sorted, minus the stamp itself. `null` when git cannot answer
// (not installed, not a work tree) — the caller then falls back to the filesystem.
function shippedFiles(distDir) {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
      { cwd: distDir, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out
      .toString("utf8")
      .split("\0")
      .filter((rel) => rel.length > 0 && rel !== STAMP_FILE)
      .sort();
  } catch {
    return null;
  }
}

// Stamp format — self-describing key=value lines, so a human `cat`ing the file can tell it from the old
// format at a glance (a bare 64-hex line, which `parseStamp` deliberately refuses; see check-plugin).
//   version=2
//   src=<64 hex>
//   dist=<64 hex>
function formatStamp(src, dist) {
  return `version=${STAMP_VERSION}\nsrc=${src}\ndist=${dist}\n`;
}

// Parse a stamp file's text → `{ src, dist }`, or `null` if it is not a verifiable v2 stamp — which covers
// both the old src-only format and anything malformed. `null` means "this stamp makes no claim about the
// committed bytes"; the caller must not treat it as green.
export function parseStamp(text) {
  const fields = new Map(
    text
      .split("\n")
      .map((line) => line.trim().split("="))
      .filter((parts) => parts.length === 2),
  );
  if (fields.get("version") !== String(STAMP_VERSION)) return null;
  const src = fields.get("src");
  const dist = fields.get("dist");
  const isHash = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
  return isHash(src) && isHash(dist) ? { src, dist } : null;
}

// Write the stamp for a just-built bundle. The dist directory is `stampPath`'s own directory — the stamp
// always covers the tree it sits in, so a build script cannot accidentally certify the wrong artifact.
// Call this AFTER the bundle has been written; `opts` is forwarded verbatim to `bundleSrcHash`.
export function writeStamp(stampPath, pkgDir, opts = {}) {
  writeFileSync(stampPath, formatStamp(bundleSrcHash(pkgDir, opts), distHash(dirname(stampPath))));
}
