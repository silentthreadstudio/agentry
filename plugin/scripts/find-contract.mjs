#!/usr/bin/env node
// find-contract — `node find-contract.mjs <id> [--root <dir>] [--process <file>] [--kind <kind>]`
// prints the item's contract block as one JSON line and exits 0 when found, 1 when not found or
// ambiguous, 2 on a usage error, a `--kind` the process file does not have among them. Root defaults to the git root
// of the working directory; the process file to `<root>/.agentry/process.json` (read with its sibling
// workflow file, `workflow.json`), used when it exists and both are valid. An invalid one is reported on stderr and left out: only the Agentry task files and
// discovered TASKS.md are searched. `--flag=value` reads as `--flag value`; any other option is a
// usage error.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { findContract, gitRootOf } from "./lib/process/contract.mjs";
import { loadSpec } from "./lib/process/read.mjs";

const USAGE = "usage: find-contract.mjs <id> [--root <dir>] [--process <file>] [--kind <kind>]\n";
const usage = (why = "") => {
  process.stderr.write(`${why ? `${why}\n` : ""}${USAGE}`);
  process.exit(2);
};
const FLAGS = ["--root", "--process", "--kind"];
const argv = process.argv.slice(2).flatMap((arg) => {
  const eq = arg.indexOf("=");
  return eq > 0 && FLAGS.includes(arg.slice(0, eq)) ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg];
});
// An option's value; an option given without one (last, or followed by another option) is a usage error.
const option = (name) => {
  const at = argv.indexOf(name);
  if (at < 0) return undefined;
  const value = argv[at + 1];
  if (!value || value.startsWith("--")) usage();
  argv.splice(at, 2);
  return value;
};
const rootArg = option("--root");
const processArg = option("--process");
const named = option("--kind");
const kind = named ?? "task";
const unknown = argv.find((a) => a.startsWith("-") && a !== "-");
if (unknown) usage(`unknown option "${unknown.split("=")[0]}"`);
const [id, extra] = argv;
if (!id || extra !== undefined) usage();
const root = resolve(rootArg ?? gitRootOf(process.cwd()) ?? process.cwd());
const specPath = resolve(processArg ?? join(root, ".agentry", "process.json"));
const loaded = existsSync(specPath) ? loadSpec(specPath, { root }) : { spec: null, problems: [] };
if (loaded.problems.length) {
  const [problem] = loaded.problems;
  process.stderr.write(`${problem.file ?? specPath}: not used (${problem.message})\n`);
}
const spec = loaded.problems.length ? null : loaded.spec;
// As `board contract`: the default `task` may be absent (task files are searched), a named kind may not.
if (spec && named && !Object.hasOwn(spec.kinds, named))
  usage(`unknown kind "${named}" (kinds: ${Object.keys(spec.kinds).join(", ")})`);
const result = findContract({ root, spec, id, kind });
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.status === "found" ? 0 : 1;
