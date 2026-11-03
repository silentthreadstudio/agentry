// router — the argv → subcommand router shared by `board.mjs` and `lane.mjs`: `<cli> [<sub>] [--root <git
// root>] [--process <file>] [--help] …`. Routes to `<dir>/<sub>.mjs`, found by name, as `run(argv, ctx) ->
// { exit, out }` with ctx `{ root, processPath, workflowPath, spec, model }`; a sub that exports `noSpec`
// runs without a process file. The workflow file is always the process file's sibling `workflow.json`. `--root`, `--process` and `--help` are the router's. A sub exports its `help`
// (`help.mjs`): the options it takes are the keys of `help.flags`, any other option is a usage error, and
// `--flag=value` reads as `--flag value`. `--help` prints the sub's help (or, with no sub named, every
// sub's purpose) and exits 0 without reading the process file. Exit 0 = OK, 1 = findings, 2 = usage or
// process-file or workflow-file error. Node built-ins only.
import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gitRootOf } from "../process/contract.mjs";
import { loadSpec, readProcess, workflowPathOf } from "../process/read.mjs";
import { checkOnBoard } from "../process/spec/rules.mjs";
import { flagsOf, renderHelp, renderIndex, say, usageError } from "./help.mjs";

const subsIn = (dir) =>
  existsSync(dir) ? readdirSync(dir).map((f) => f.replace(/\.mjs$/, "")) : [];
const isSub = (dir, sub) => /^[a-z][a-z-]*$/.test(sub) && existsSync(join(dir, `${sub}.mjs`));
const load = (dir, sub) => import(pathToFileURL(join(dir, `${sub}.mjs`)).href);

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

// The sub's argv with `--flag=value` spelled `--flag value`, or why the first option it does not take
// is refused.
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

// `<cli> --help`: each sub's purpose, read from its own help.
async function index(dir, cli) {
  const subs = [];
  for (const name of subsIn(dir)) subs.push({ name, help: (await load(dir, name)).help });
  return { exit: 0, out: renderIndex(cli, subs) };
}

/** Run `argv` against the subcommands in `dir`. `defaultSub` names the sub used when none is given
 *  (none given and no default → a usage error); `name` is the CLI's name in help and errors.
 *  Returns `{ exit, out }`. */
export async function route(argv, { dir, defaultSub, name: cli = "cli" }) {
  const rootArg = take(argv, "--root");
  const processArg = take(argv, "--process");
  for (const [name, value] of [
    ["--root", rootArg],
    ["--process", processArg],
  ])
    if (value === null) return usageError(cli, `${name} needs a value`);
  const root = resolve(rootArg ?? gitRootOf(process.cwd()) ?? process.cwd());
  const processPath = resolve(processArg ?? join(root, ".agentry", "process.json"));
  const named = argv[0] && !argv[0].startsWith("-") ? argv.shift() : null;
  const helpAt = argv.indexOf("--help");
  if (helpAt >= 0 && !named) return index(dir, cli);
  const sub = named ?? defaultSub;
  if (!sub || !isSub(dir, sub)) {
    const why = sub ? `unknown subcommand "${sub}"` : "no subcommand";
    return usageError(cli, `${why} (subcommands: ${subsIn(dir).join(", ")})`);
  }
  const mod = await load(dir, sub);
  if (helpAt >= 0) return { exit: 0, out: renderHelp(cli, sub, mod.help) };
  const { argv: args, error } = options(argv, flagsOf(mod.help));
  if (error) return usageError(`${cli} ${sub}`, error);
  const workflowPath = workflowPathOf(processPath);
  if (mod.noSpec) return mod.run(args, { root, processPath, workflowPath });
  const shown = (path) => (relative(root, path).startsWith("..") ? path : relative(root, path));
  // One block per file with problems, the process file first: its header, then its own problems.
  const block = (path, head, some) => [
    say(shown(path), head, "/agentry:init"),
    ...some.map((p) => `  ${p.message}`),
  ];
  const refuse = (problems) => {
    const ofWorkflow = problems.filter((p) => p.file === workflowPath);
    const ofProcess = problems.filter((p) => p.file !== workflowPath);
    const why = existsSync(processPath) ? "cannot use the process file" : "no process file here";
    const out = [
      ...(ofProcess.length || !ofWorkflow.length ? block(processPath, why, ofProcess) : []),
      ...(ofWorkflow.length ? block(workflowPath, "cannot use the workflow file", ofWorkflow) : []),
    ];
    return { exit: 2, out: out.join("\n") };
  };
  const { spec, problems } = loadSpec(processPath, { root });
  if (!spec || problems.length) return refuse(problems);
  const model = readProcess({ root, spec });
  const late = checkOnBoard(spec, model, { file: processPath });
  if (late.length) return refuse(late);
  return mod.run(args, { root, processPath, workflowPath, spec, model });
}

/** The bin wrapper: route, print to stdout (or stderr on exit 2), set the exit code. */
export async function main(argv, opts) {
  const { exit, out } = await route(argv, opts);
  if (out) (exit === 2 ? process.stderr : process.stdout).write(`${out}\n`);
  process.exitCode = exit;
}
