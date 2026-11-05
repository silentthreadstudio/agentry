// board status [--json] [--why <id>] — the derived view (plan F13 §3.5): what is in flight, what waits
// on the owner, what is blocked and ahead, then the findings. Also what `board.mjs` runs with no
// subcommand. Writes nothing. Exit 0 = OK, 1 = findings, 2 = a conductor key it cannot use (as
// `board check`).
//
// run(argv, { root, processPath, spec, model }) -> { exit, out }
import { usageError } from "../../cli/help.mjs";
import { refuseConductor } from "../conductor.mjs";
import { mainRoot } from "../git.mjs";
import { boardId } from "../ids.mjs";
import { readyView, renderReady } from "../ready.mjs";
import { renderStatus, why } from "../render.mjs";
import { shownPath } from "../shown-path.mjs";
import { boardReport, statusView, workKind } from "../status.mjs";

export const help = {
  usage: "status [--json] [--why <id>] [--ready]",
  purpose: "The derived view: in flight, on the owner, blocked, ahead, drift, then the findings.",
  args: {},
  flags: {
    "--json": "print the report and the view as one JSON object",
    "--ready": "open tasks per sprint: contract found, dependencies done (with --json too)",
    "--why <id>":
      "one item of any kind, any case (task, sprint, D7…): each rule failing or holding",
  },
  exits: {
    0: "no findings",
    1: "findings",
    2: "usage, an id not on the board, or a process file or conductor key it cannot use",
  },
  example: "board status --json",
};
const tty = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const clock = () => new Date().toTimeString().slice(0, 5);

export function run(argv, { root, processPath, workflowPath, spec, model }) {
  const refused = refuseConductor(root, spec, workflowPath);
  if (refused) return refused;
  const report = boardReport({ root, spec, model });
  const exit = report.ok ? 0 : 1;
  if (argv.includes("--ready")) {
    const view = readyView({ root, spec, model });
    if (argv.includes("--json"))
      return { exit: 0, out: JSON.stringify({ name: spec.name, ready: view }) };
    return { exit: 0, out: renderReady({ name: spec.name, view }) };
  }
  const at = argv.indexOf("--why");
  const id = boardId(spec, model, argv[at + 1]);
  if (at >= 0 && (!id || id.startsWith("--")))
    return usageError("board status", "--why needs an id");
  if (at >= 0) return why({ spec, model, report, id, tty: tty() });
  const view = statusView({ root, spec, model, runRoot: mainRoot(root) ?? root });
  if (argv.includes("--json")) return { exit, out: JSON.stringify({ ...report, status: view }) };
  const shown = processPath ? shownPath(root, processPath) : "";
  const subtitle = [spec.root, shown, `read ${clock()}`].filter(Boolean).join(" · ");
  const work = workKind(spec);
  return { exit, out: renderStatus({ spec, report, view, work, subtitle, tty: tty() }) };
}
