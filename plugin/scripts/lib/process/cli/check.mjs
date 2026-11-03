// board check [--json] [--why <id>] — read the board, run the process file's rules, print the
// verdict and the findings (plan F13 §2.4). Writes nothing. Exit 0 = OK, 1 = findings, 2 = a
// `conductor.prompt` that is not a file or a `conductor.rules` heading it does not hold.
//
// run(argv, { root, spec, model }) -> { exit, out }
import { usageError } from "../../cli/help.mjs";
import { refuseConductor } from "../conductor.mjs";
import { boardId } from "../ids.mjs";
import { renderCheck, why } from "../render.mjs";
import { boardReport, workKind } from "../status.mjs";

export const help = {
  usage: "check [--json] [--why <id>]",
  purpose: "Run the process file's rules on the board; print the verdict and every finding.",
  args: {},
  flags: {
    "--json": "print the report as one JSON object",
    "--why <id>":
      "one item of any kind, any case (task, sprint, D7…): each rule failing or holding",
  },
  exits: {
    0: "no findings",
    1: "findings",
    2: "usage, an id not on the board, or a process file or conductor key it cannot use",
  },
  example: "board check --why T-4",
};
const tty = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

export function run(argv, { root, processPath, spec, model }) {
  const refused = refuseConductor(root, spec, processPath);
  if (refused) return refused;
  const report = boardReport({ root, spec, model });
  const exit = report.ok ? 0 : 1;
  const at = argv.indexOf("--why");
  const id = boardId(spec, model, argv[at + 1]);
  if (at >= 0 && (!id || id.startsWith("--")))
    return usageError("board check", "--why needs an id");
  if (at >= 0) return why({ spec, model, report, id, tty: tty() });
  if (argv.includes("--json")) return { exit, out: JSON.stringify(report) };
  return { exit, out: renderCheck({ spec, report, work: workKind(spec), tty: tty() }) };
}
