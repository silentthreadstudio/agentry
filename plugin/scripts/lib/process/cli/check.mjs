// board check [--json] [--why <id>] — read the board, run the process file's rules, print the
// verdict and the findings (plan F13 §2.4). Writes nothing. Exit 0 = OK, 1 = findings.
//
// run(argv, { root, spec, model }) -> { exit, out }
import { renderCheck, why } from "../render.mjs";
import { boardReport, workKind } from "../status.mjs";

const tty = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

export function run(argv, { root, spec, model }) {
  const report = boardReport({ root, spec, model });
  const exit = report.ok ? 0 : 1;
  const id = argv.includes("--why") ? argv[argv.indexOf("--why") + 1] : undefined;
  if (id) return why({ spec, model, report, id, tty: tty() });
  if (argv.includes("--json")) return { exit, out: JSON.stringify(report) };
  return { exit, out: renderCheck({ spec, report, work: workKind(spec), tty: tty() }) };
}
