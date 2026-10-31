#!/usr/bin/env node
// find-contract — `node find-contract.mjs <id> [--root <dir>] [--process <file>] [--kind <kind>]`
// prints the item's contract block as one JSON line and exits 0 when found, 1 when not found or
// ambiguous, 2 on a usage error (plan F13 §8, keeping F2's interface). Root defaults to the git root
// of the working directory; the process file to `<root>/.agentry/process.json`, used when it exists
// and is valid (otherwise only the Agentry task files and discovered TASKS.md are searched).
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { findContract, gitRootOf } from "./lib/process/contract.mjs";
import { loadSpec } from "./lib/process/read.mjs";

const argv = process.argv.slice(2);
const option = (name) => {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv.splice(at, 2)[1];
};
const rootArg = option("--root");
const processArg = option("--process");
const kind = option("--kind") ?? "task";
const [id, extra] = argv;
if (!id || id.startsWith("-") || extra !== undefined) {
  process.stderr.write(
    "usage: find-contract.mjs <id> [--root <dir>] [--process <file>] [--kind <kind>]\n",
  );
  process.exit(2);
}
const root = resolve(rootArg ?? gitRootOf(process.cwd()) ?? process.cwd());
const specPath = resolve(processArg ?? join(root, ".agentry", "process.json"));
const loaded = existsSync(specPath) ? loadSpec(specPath) : { spec: null, problems: [] };
const spec = loaded.problems.length ? null : loaded.spec;
const result = findContract({ root, spec, id, kind });
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.status === "found" ? 0 : 1;
