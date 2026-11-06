// Tests for scripts/build-agentry-opencode.mjs: the vendor copy is exactly the one file-set
// definition's set, regenerates byte-for-byte, and its --check gate loses sync loudly. Also the
// package manifest's publish shape, and the shape of the tarball npm would build. Vendor cases run in
// a temp package dir; the tarball case packs the real one (npm pack --dry-run is offline — no deps).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { vendoredFiles } from "../plugin/scripts/lib/cli/init-vendor.mjs";
import { generate, main } from "./build-agentry-opencode.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PLUGIN = join(ROOT, "plugin");
const PKG = join(ROOT, "packages", "agentry-opencode");

const tmp = mkdtempSync(join(tmpdir(), "build-agentry-opencode-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

// A fresh temp package dir; when `from` is true, generate returns its vendor copy first.
function pkgDir(from = true) {
  const dir = join(tmp, `pkg-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  if (from) return generate(dir).then(() => dir);
  return dir;
}

// console.error captured while `fn` runs, then restored: what the gate printed.
async function captureErr(fn) {
  const lines = [];
  const real = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    return { code: await fn(), lines };
  } finally {
    console.error = real;
  }
}

describe("generate", () => {
  it("writes exactly vendoredFiles(plugin)'s set, with the bin executable", async () => {
    const dir = await pkgDir();
    const files = vendoredFiles(PLUGIN);
    assert.ok(files.length > 100);
    const written = [];
    for (const f of files) {
      const target = join(dir, "vendor", f.path);
      assert.ok(existsSync(target), `${f.path} missing`);
      assert.deepEqual(readFileSync(target), f.bytes);
      written.push(f.path);
    }
    const walked = [];
    for (const f of vendoredFiles(PLUGIN)) walked.push(f.path); // the set is the definition, not walking
    assert.deepEqual(written, walked);
    assert.ok(
      statSync(join(dir, "vendor", "bin/agentry")).mode & 0o111,
      "bin lost its executable bit",
    );
  });

  it("regenerates byte-for-byte", async () => {
    const dir = await pkgDir();
    await generate(dir);
    // a write that lost a suffix would differ; the set is one definition, both writers
    for (const f of vendoredFiles(PLUGIN))
      assert.deepEqual(readFileSync(join(dir, "vendor", f.path)), f.bytes);
  });
});

describe("--check", () => {
  it("is in sync right after generate (exit 0)", async () => {
    const dir = await pkgDir();
    const { code } = await captureErr(() => main(["--check", "--out", dir]));
    assert.equal(code, 0);
  });

  it("names each drifted path and exits 1", async () => {
    const dir = await pkgDir();
    writeFileSync(join(dir, "vendor", "scripts", "lib", "cli", "router.mjs"), "// poison\n");
    rmSync(join(dir, "vendor", "scripts", "lane.mjs"));
    writeFileSync(join(dir, "vendor", "stowaway.txt"), "x\n");
    const { code, lines } = await captureErr(() => main(["--check", "--out", dir]));
    assert.equal(code, 1);
    assert.equal(lines.length, 4, "header + one line per drifted path");
    const rest = lines.slice(1);
    for (const path of [
      "vendor/scripts/lib/cli/router.mjs",
      "absent: vendor/scripts/lane.mjs",
      "extra: vendor/stowaway.txt",
    ])
      assert.ok(
        rest.some((l) => l.includes(path)),
        `stderr does not name ${path}: ${rest.join(" | ")}`,
      );
  });

  it("names a bin whose executable bit is gone", async () => {
    const dir = await pkgDir();
    chmodSync(join(dir, "vendor", "bin", "agentry"), 0o644);
    const { code, lines } = await captureErr(() => main(["--check", "--out", dir]));
    assert.equal(code, 1);
    assert.ok(lines.join("\n").includes("mode: vendor/bin/agentry"), lines.join(" | "));
  });

  it("is one named absence when there is no vendor copy at all", async () => {
    const bare = await pkgDir(false);
    const { code, lines } = await captureErr(() => main(["--check", "--out", bare]));
    assert.equal(code, 1);
    assert.ok(lines[0].startsWith("✗ build-agentry-opencode --check:"), lines.join(" | "));
    assert.ok(lines.join("\n").includes("absent: vendor/"), lines.join(" | "));
  });

  it("refuses unknown arguments and a --out with no value (exit 2)", async () => {
    const { code: bad } = await captureErr(() => main(["--bogus"]));
    assert.equal(bad, 2);
    const { code: bare } = await captureErr(() => main(["--out"]));
    assert.equal(bare, 2);
  });
});

describe("the package", () => {
  it("manifest: plugin.json's version, type module, MIT, files whitelist, engines >=24, zero deps", () => {
    const m = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
    const p = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(m.name, "agentry-opencode");
    assert.equal(m.version, p.version);
    assert.equal(m.type, "module");
    assert.equal(m.license, "MIT");
    assert.equal(m.exports["."], "./index.js");
    assert.equal(m.engines.node, ">=24");
    for (const wanted of ["index.js", "src/**", "vendor/**", "README.md"])
      assert.ok(m.files.includes(wanted), `files whitelist omits ${wanted}`);
    assert.ok(!("dependencies" in m));
    assert.ok(!("devDependencies" in m));
  });

  it("npm pack --dry-run: the vendored core rides along, bin executable, nothing extra", () => {
    const res = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: PKG,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(res);
    const pack = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
    const entries = new Map(pack.files.map((e) => [e.path.replace(/^package\//, ""), e]));
    const bin = entries.get("vendor/bin/agentry");
    assert.ok(bin, "tarball has no vendor/bin/agentry");
    // npm versions disagree on how a mode is reported: stat-mode octal string or decimal permission bits
    const octal = typeof bin.mode === "string" ? bin.mode : bin.mode.toString(8);
    assert.ok(octal === "100755" || octal === "755", `bin mode ${octal} is not executable`);
    for (const wanted of [
      "vendor/scripts/lib/memory/persistence/db-index.mjs",
      "vendor/scripts/lib/cli/router.mjs",
    ])
      assert.ok(entries.has(wanted), `tarball has no ${wanted}`);
    const bad = [...entries.keys()].filter((path) => /(^|\/)(node_modules|test)\//.test(path));
    assert.deepEqual(bad, [], "tarball ships generated or test noise");
    assert.ok(entries.has("README.md") && entries.has("index.js"));
  });

  it("the shipped vendor copy is the real one: the generator's own --check passes on it", () => {
    const real = execFileSync(
      process.execPath,
      [join(HERE, "build-agentry-opencode.mjs"), "--check"],
      {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.ok(real.includes("in sync"));
  });
});
