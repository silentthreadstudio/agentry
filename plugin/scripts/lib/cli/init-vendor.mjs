// init-vendor — the vendored CLI of `agentry init --vendor`: a runnable copy of this bin and the
// scripts its groups route to, under <root>/.agentry/ (`bin/agentry`, `scripts/<group>.mjs`,
// `scripts/lib/**`), plus a version stamp (`bin/.agentry-version`, one line) naming what was copied.
// `agentry board explain` reads the stamp back to warn when the copy is behind the plugin, so the copy
// and its read-back live in one place beside the verb that writes them. Test files, `node_modules` and
// `.docs` never copy; the bin keeps its executable bit. Node built-ins only.
//
// stampOf(root) -> string | null                                  the copy's version, read back
// relationWord(plugin, stamp) -> "newer" | "older" | "differs"      which side is ahead
// vendorVersion(source) -> string | null                            the source plugin's version
// vendoredFiles(source) -> [{ path, src, bytes }]                   the copy's file set, sorted
// planVendor(root, source) -> { version, changed, drift }            whether the copy is behind
// applyVendor(root, source) -> { version, changed, refreshed }       write it (rm the two dirs first)
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The plugin root (as the generator addresses it) the vendored copy stands in for. */
export const VENDOR_ROOT = ".agentry";
const STAMP = `${VENDOR_ROOT}/bin/.agentry-version`;
const BIN = "bin/agentry";
const TOP_SCRIPTS = ["board.mjs", "lane.mjs", "mem.mjs", "init.mjs"];
// A directory that never copies: tests the CLI does not run, dependencies it does not have, docs it
// does not read.
const SKIP_DIR = new Set(["node_modules", ".docs", "test", "tests"]);

/** The name of every file under `dir`, as `<sub>/…<name>`, sorted. */
function walkFiles(dir, base = "") {
  const out = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      out.push(...walkFiles(join(dir, e.name), `${base}${e.name}/`));
      continue;
    }
    if (/\.test\.|\.spec\./.test(e.name)) continue;
    out.push({ path: `${base}${e.name}`, src: join(dir, e.name) });
  }
  return out;
}

/** The version stamp under `root`'s .agentry/, trimmed; null when it is gone or empty. */
export function stampOf(root) {
  try {
    const text = readFileSync(join(root, STAMP), "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

/** `<a>` against `<b>` by semver parts: -1, 0 or 1; null when either is not `n(.n…)`. */
export function compareVersions(a, b) {
  const parse = (text) => (typeof text === "string" ? (text.match(/^v?(\d+(?:\.\d+)*)/) ?? [])[1] : undefined);
  const first = parse(a);
  const second = parse(b);
  if (!first || !second) return null;
  const left = first.split(".").map(Number);
  const right = second.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const part = (left[i] ?? 0) - (right[i] ?? 0);
    if (part) return part < 0 ? -1 : 1;
  }
  return 0;
}

/** Which copy runs ahead, in the lane row's word: `plugin` over `stamp` calls the stamp behind. */
export function relationWord(plugin, stamp) {
  const order = compareVersions(plugin, stamp);
  return order === null ? "differs" : order > 0 ? "newer" : order < 0 ? "older" : "differs";
}

/** The source plugin's own version, read back; null when its manifest says none. */
export function vendorVersion(source) {
  try {
    const { version } = JSON.parse(readFileSync(join(source, ".claude-plugin", "plugin.json"), "utf8"));
    return version ?? null;
  } catch {
    return null;
  }
}

/** What a vendored copy carries, sorted: the bin, this CLI's own top scripts and all of `scripts/lib`. */
export function vendoredFiles(source) {
  const out = [];
  const bin = join(source, BIN);
  if (existsSync(bin)) out.push({ path: BIN, src: bin, bytes: readFileSync(bin) });
  for (const name of TOP_SCRIPTS) {
    const file = join(source, "scripts", name);
    if (existsSync(file)) out.push({ path: `scripts/${name}`, src: file, bytes: readFileSync(file) });
  }
  const lib = join(source, "scripts", "lib");
  if (existsSync(lib))
    for (const { path, src } of walkFiles(lib, "lib/"))
      out.push({ path: `scripts/${path}`, src, bytes: readFileSync(src) });
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** What a vendored copy would write under `root`: drift when any carried file is missing or differs,
 *  or when the stamp is absent or behind. `changed` is that difference, one `{ path, write }` each. */
export function planVendor(root, source) {
  const files = vendoredFiles(source);
  const version = vendorVersion(source);
  const changed = [];
  for (const file of files) {
    const target = join(root, VENDOR_ROOT, file.path);
    let bytes = null;
    try {
      bytes = readFileSync(target);
    } catch {
      changed.push({ path: `${VENDOR_ROOT}/${file.path}`, write: "new" });
    }
    if (bytes !== null && bytes.compare(file.bytes) !== 0)
      changed.push({ path: `${VENDOR_ROOT}/${file.path}`, write: "rewrite" });
  }
  const stamp = stampOf(root);
  if (stamp !== version)
    changed.push({ path: STAMP, write: stamp === null ? "new" : "rewrite", why: `stamp ${stamp ?? "gone"} vs ${version}` });
  return { version, files, changed, drift: changed.length > 0 };
}

/** The vendored copy written: the two directories gone, every carried file back (the bin executable),
 *  the stamp one version line. Returns what changed, as the plan said. */
export function applyVendor(root, source) {
  const plan = planVendor(root, source);
  if (!plan.drift) return { ...plan, refreshed: false };
  const home = join(root, VENDOR_ROOT);
  for (const dir of ["bin", "scripts"]) {
    rmSync(join(home, dir), { recursive: true, force: true });
    mkdirSync(join(home, dir), { recursive: true });
  }
  for (const file of plan.files) {
    const target = join(home, file.path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, file.bytes);
    try {
      if (statSync(file.src).mode & 0o111) chmodSync(target, statSync(file.src).mode);
    } catch {
      // not executable in the source: copied as plain data
    }
  }
  writeFileSync(join(root, STAMP), `${plan.version ?? "(version unknown)"}\n`);
  return { ...plan, refreshed: true };
}
