// board check [--json] [--why <id>] — read the board, run the process file's rules, print the
// verdict and the findings (plan F13 §2.4). Writes nothing. Exit 0 = OK, 1 = findings.
//
// run(argv, { root, spec, model }) -> { exit, out }
import { renderCheck, why } from "../render.mjs";
import { boardReport, workKind } from "../status.mjs";

export const usage = "check [--json] [--why <id>]";
export const flags = { "--json": false, "--why": true };
const tty = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

export function run(argv, { root, spec, model }) {
  const report = boardReport({ root, spec, model });
  const exit = report.ok ? 0 : 1;
  const at = argv.indexOf("--why");
  const id = argv[at + 1];
  if (at >= 0 && (!id || id.startsWith("--"))) return { exit: 2, out: `usage: ${usage}` };
  if (at >= 0) return why({ spec, model, report, id, tty: tty() });
  if (argv.includes("--json")) return { exit, out: JSON.stringify(report) };
  return { exit, out: renderCheck({ spec, report, work: workKind(spec), tty: tty() }) };
}
