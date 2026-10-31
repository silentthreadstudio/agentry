#!/usr/bin/env node
// board — the process kit's CLI (plan F13 §2.4): `board.mjs [<sub>] [--root <git root>] [--process
// <file>] …`. Routes to `lib/process/cli/<sub>.mjs`, found by name, as `run(argv, ctx) -> { exit, out }`
// with ctx `{ root, processPath, spec, model }`; a sub that exports `noSpec` runs without a process file.
// `--root` and `--process` are the router's; every other argument reaches the sub untouched. No sub =
// `status`. Exit 0 = OK, 1 = findings, 2 = usage or process-file error. Node built-ins only.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitRootOf } from "./lib/process/contract.mjs";
import { loadSpec, readProcess } from "./lib/process/read.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "lib", "process", "cli");
const subs = () => readdirSync(CLI).map((f) => f.replace(/\.mjs$/, ""));

function take(argv, name) {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv.splice(at, 2)[1];
}

async function main(argv) {
  const rootArg = take(argv, "--root");
  const root = resolve(rootArg ?? gitRootOf(process.cwd()) ?? process.cwd());
  const processPath = resolve(take(argv, "--process") ?? join(root, ".agentry", "process.json"));
  const sub = argv[0] && !argv[0].startsWith("--") ? argv.shift() : "status";
  const file = join(CLI, `${sub}.mjs`);
  if (!/^[a-z][a-z-]*$/.test(sub) || !existsSync(file))
    return { exit: 2, out: `unknown subcommand "${sub}" (subcommands: ${subs().join(", ")})` };
  const mod = await import(pathToFileURL(file).href);
  if (mod.noSpec) return mod.run(argv, { root, processPath });
  const { spec, problems } = loadSpec(processPath);
  if (!spec || problems.length) {
    const shown = relative(root, processPath).startsWith("..")
      ? processPath
      : relative(root, processPath);
    const hint = existsSync(processPath) ? "" : "\n  no process file here: run /agentry:init";
    const lines = problems.map((p) => `  ${p.message}`);
    return {
      exit: 2,
      out: [`✗ ${shown}: cannot use the process file`, ...lines].join("\n") + hint,
    };
  }
  return mod.run(argv, { root, processPath, spec, model: readProcess({ root, spec }) });
}

const { exit, out } = await main(process.argv.slice(2));
if (out) (exit === 2 ? process.stderr : process.stdout).write(`${out}\n`);
process.exitCode = exit;
