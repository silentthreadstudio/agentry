// router — the argv → subcommand router shared by `board.mjs` and `lane.mjs`: `<cli> [<sub>] [--root <git
// root>] [--process <file>] …`. Routes to `<dir>/<sub>.mjs`, found by name, as `run(argv, ctx) -> { exit,
// out }` with ctx `{ root, processPath, spec, model }`; a sub that exports `noSpec` runs without a process
// file. `--root` and `--process` are the router's. A sub exports its `usage` line and the `flags` it takes
// ({ "--json": false, "--why": true }, true = takes a value): any other option is a usage error, and
// `--flag=value` reads as `--flag value`. Exit 0 = OK, 1 = findings, 2 = usage or process-file error.
// Node built-ins only.
import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gitRootOf } from "../process/contract.mjs";
import { loadSpec, readProcess } from "../process/read.mjs";
import { checkOnBoard } from "../process/spec.mjs";

const subsIn = (dir) =>
  existsSync(dir) ? readdirSync(dir).map((f) => f.replace(/\.mjs$/, "")) : [];

// A router option's value: undefined when absent, null when given without one (last, followed by
// another option, or `--root=`).
function take(argv, name) {
  const at = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (at < 0) return undefined;
  if (argv[at] !== name) return argv.splice(at, 1)[0].slice(name.length + 1) || null;
  const value = argv[at + 1];
  const given = value !== undefined && !value.startsWith("--");
  argv.splice(at, given ? 2 : 1);
  return given ? value : null;
}

// The sub's argv with `--flag=value` spelled `--flag value`, or the first option it does not take.
function options(argv, takes) {
  const out = [];
  for (const arg of argv) {
    if (!arg.startsWith("-") || arg === "-") {
      out.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (!Object.hasOwn(takes, name)) return { error: `unknown option "${name}"` };
    if (eq >= 0 && !takes[name]) return { error: `${name} takes no value` };
    out.push(...(eq < 0 ? [name] : [name, arg.slice(eq + 1)]));
  }
  return { argv: out };
}

/** Run `argv` against the subcommands in `dir`. `defaultSub` names the sub used when none is given
 *  (none given and no default → a usage error). Returns `{ exit, out }`. */
export async function route(argv, { dir, defaultSub }) {
  const rootArg = take(argv, "--root");
  const processArg = take(argv, "--process");
  for (const [name, value] of [
    ["--root", rootArg],
    ["--process", processArg],
  ])
    if (value === null) return { exit: 2, out: `${name} needs a value` };
  const root = resolve(rootArg ?? gitRootOf(process.cwd()) ?? process.cwd());
  const processPath = resolve(processArg ?? join(root, ".agentry", "process.json"));
  const sub = argv[0] && !argv[0].startsWith("--") ? argv.shift() : defaultSub;
  const file = sub ? join(dir, `${sub}.mjs`) : null;
  if (!sub || !/^[a-z][a-z-]*$/.test(sub) || !existsSync(file))
    return {
      exit: 2,
      out: `${sub ? `unknown subcommand "${sub}"` : "no subcommand"} (subcommands: ${subsIn(dir).join(", ")})`,
    };
  const mod = await import(pathToFileURL(file).href);
  const { argv: args, error } = options(argv, mod.flags ?? {});
  if (error) return { exit: 2, out: `${error}\nusage: ${mod.usage ?? sub}` };
  if (mod.noSpec) return mod.run(args, { root, processPath });
  const refuse = (problems) => {
    const shown = relative(root, processPath).startsWith("..")
      ? processPath
      : relative(root, processPath);
    const hint = existsSync(processPath) ? "" : "\n  no process file here: run /agentry:init";
    const lines = problems.map((p) => `  ${p.message}`);
    return {
      exit: 2,
      out: [`✗ ${shown}: cannot use the process file`, ...lines].join("\n") + hint,
    };
  };
  const { spec, problems } = loadSpec(processPath, { root });
  if (!spec || problems.length) return refuse(problems);
  const model = readProcess({ root, spec });
  const late = checkOnBoard(spec, model, { file: processPath });
  if (late.length) return refuse(late);
  return mod.run(args, { root, processPath, spec, model });
}

/** The bin wrapper: route, print to stdout (or stderr on exit 2), set the exit code. */
export async function main(argv, opts) {
  const { exit, out } = await route(argv, opts);
  if (out) (exit === 2 ? process.stderr : process.stdout).write(`${out}\n`);
  process.exitCode = exit;
}
