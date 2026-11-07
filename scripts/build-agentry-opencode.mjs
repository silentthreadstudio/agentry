#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
// build-agentry-opencode — regenerates packages/agentry-opencode/vendor/** from plugin/.
//
// The OpenCode V2 adapter ships as the npm package `agentry-opencode`; its vendor/ carries a runnable
// copy of the CLI core so the package can import the portable core in-process and an installed consumer
// can still run the Tier-1 fallback (`vendor/bin/agentry`) even in a repo that never vendored to
// .agentry/. The copy set is the one `agentry init --vendor` carries:
// plugin/scripts/lib/cli/init-vendor.mjs's vendoredFiles() is the one file-set definition and this
// script its second writer — edit plugin/ and rerun this, never hand-edit vendor/.
//
// vendor/ is also a plugin layout: beside the CLI it carries the payload source (agents/, commands/,
// skills/, .claude-plugin/plugin.json) and the generator (scripts/build-opencode.mjs), so the vendored
// `agentry init --host opencode` finds its own source and generates exactly as it does in a checkout.
//
// usage: node scripts/build-agentry-opencode.mjs [--out <package-dir>] [--check]
//   --out    the package dir whose vendor/ is written (default: this repo's packages/agentry-opencode)
//   --check  regenerate to a temp dir and require zero drift (nothing written)
// exits: 0 ok / in sync · 1 drift on --check · 2 refused or usage. Node built-ins only.
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vendoredFiles } from "../plugin/scripts/lib/cli/init-vendor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, ".."); // this repo
const PLUGIN = join(ROOT, "plugin"); // the vendored core's single source
const DEFAULT_OUT = join(ROOT, "packages", "agentry-opencode"); // the package the core ships in

const USAGE = `usage: node scripts/build-agentry-opencode.mjs [--out <package-dir>] [--check]
  --out    the package dir whose vendor/ is written (default: packages/agentry-opencode)
  --check  regenerate to a temp dir and require zero drift (no files written)
example: node scripts/build-agentry-opencode.mjs`;

// Every file written under <out>/vendor, sorted; one `<rel>` entry per path.
async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out.sort();
}

// Every file under `dir` as `{ path: <prefix><rel>, src }`, sorted.
async function filesUnder(dir, prefix) {
  const out = [];
  for (const p of await walk(dir)) out.push({ path: `${prefix}${relative(dir, p)}`, src: p });
  return out;
}

// What the package's vendor/ carries, sorted by path: the CLI's own set plus the payload source and the
// generator `init` runs. A path both name (the skill templates) is carried once.
export async function packageFiles(source = PLUGIN) {
  const found = [
    ...(await filesUnder(join(source, "agents"), "agents/")),
    ...(await filesUnder(join(source, "commands"), "commands/")),
    ...(await filesUnder(join(source, "skills"), "skills/")),
    { path: ".claude-plugin/plugin.json", src: join(source, ".claude-plugin", "plugin.json") },
    { path: "scripts/build-opencode.mjs", src: join(ROOT, "scripts", "build-opencode.mjs") },
  ];
  const files = new Map(vendoredFiles(source).map((f) => [f.path, f]));
  for (const { path, src } of found) files.set(path, { path, src, bytes: await readFile(src) });
  return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

// vendor/ written from scratch: the whole directory gone, then every carried file back, the bin and the
// scripts the source marks executable keeping their mode. The version stamp `init --vendor` writes is
// NOT part of the set (vendoredFiles does not carry it): the package's own freshness is npm's.
export async function generate(out, source = PLUGIN) {
  const dst = join(out, "vendor");
  await rm(dst, { recursive: true, force: true });
  await mkdir(dst, { recursive: true });
  const files = await packageFiles(source);
  for (const file of files) {
    const target = join(dst, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
    try {
      const mode = statSync(file.src).mode;
      if (mode & 0o111) await chmod(target, mode);
    } catch {
      // not executable in the source: copied as plain data
    }
  }
  return files.length;
}

// The drift between <out>/vendor and a fresh regeneration, as one `path` each, sorted: differing
// (`vendor/<path>`), missing (`absent:`), surplus (`extra:`) and an executable bit that no longer
// matches the source (`mode:`). Empty when they are in sync.
async function drift(out, source = PLUGIN) {
  const probe = join(out, ".vendor-check");
  const real = join(out, "vendor");
  const drift0 = [];
  if (!existsSync(real)) return ["absent: vendor/"]; // the whole copy missing is one named thing
  try {
    await generate(probe, source);
    const files = new Map((await packageFiles(source)).map((f) => [f.path, f]));
    for (const [path, file] of files) {
      const target = join(real, path);
      let bytes = null;
      let mode = null;
      try {
        bytes = readFileSync(target);
        mode = statSync(target).mode & 0o111;
      } catch {}
      if (bytes === null) {
        drift0.push(`absent: vendor/${path}`);
        continue;
      }
      if (bytes.compare(file.bytes) !== 0) drift0.push(`vendor/${path}`);
      else if ((statSync(file.src).mode & 0o111) !== mode) drift0.push(`mode: vendor/${path}`);
    }
    for (const p of await walk(real)) {
      const path = relative(real, p);
      if (!files.has(path)) drift0.push(`extra: vendor/${path}`);
    }
    return drift0.sort();
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

async function checked(out) {
  const drift0 = await drift(out);
  if (drift0.length) {
    console.error(
      "✗ build-agentry-opencode --check: vendor out of sync → node scripts/build-agentry-opencode.mjs",
    );
    for (const d of drift0.slice(0, 20)) console.error(`  ${d}`);
    return 1;
  }
  console.log("✓ build-agentry-opencode --check: vendor in sync");
  return 0;
}

// A valued flag's value from argv (resolved), or undefined when absent; null when it takes a value and
// is the last word. Returns what is left of argv once the flag and its value are out.
function flagOf(argv0, name) {
  const argv = [...argv0];
  const i = argv.indexOf(name);
  if (i < 0) return { value: undefined, argv };
  const next = argv[i + 1];
  if (next === undefined || next === "" || next.startsWith("--")) return { value: null, argv };
  argv.splice(i, 2);
  return { value: resolve(next), argv };
}

function unknownArgs(argv) {
  return argv.filter(
    (a) => (a.startsWith("--") && !/^--(out|check|help)$/.test(a)) || !a.startsWith("-"),
  );
}

export async function main(argv0 = process.argv.slice(2)) {
  if (argv0.includes("--help") || argv0.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const check = argv0.includes("--check");
  const outFlag = flagOf(argv0, "--out");
  if (outFlag.value === null) {
    console.error("✗ build-agentry-opencode: --out is last without its value → --help");
    return 2;
  }
  const bad = unknownArgs(outFlag.argv);
  if (bad.length) {
    console.error(`✗ build-agentry-opencode: unknown argument(s) ${bad.join(" ")} → --help`);
    return 2;
  }
  const out = outFlag.value ?? DEFAULT_OUT;
  if (check) return checked(out);
  const n = await generate(out);
  console.log(
    `✓ build-agentry-opencode: wrote ${n} files → ${relative(ROOT, join(out, "vendor"))}`,
  );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}
