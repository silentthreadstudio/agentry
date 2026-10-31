// board status [--json] [--why <id>] — the derived view (plan F13 §3.5): what is in flight, what waits
// on the owner, what is blocked and ahead, then the findings. Also what `board.mjs` runs with no
// subcommand. Writes nothing. Exit 0 = OK, 1 = findings.
//
// run(argv, { root, processPath, spec, model }) -> { exit, out }
import { relative } from "node:path";
import { renderStatus, why } from "../render.mjs";
import { boardReport, statusView, workKind } from "../status.mjs";

export const usage = "status [--json] [--why <id>]";
export const flags = { "--json": false, "--why": true };
const tty = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const clock = () => new Date().toTimeString().slice(0, 5);

export function run(argv, { root, processPath, spec, model }) {
  const report = boardReport({ root, spec, model });
  const exit = report.ok ? 0 : 1;
  const at = argv.indexOf("--why");
  const id = argv[at + 1];
  if (at >= 0 && (!id || id.startsWith("--"))) return { exit: 2, out: `usage: ${usage}` };
  if (at >= 0) return why({ spec, model, report, id, tty: tty() });
  const view = statusView({ root, spec, model });
  if (argv.includes("--json")) return { exit, out: JSON.stringify({ ...report, status: view }) };
  const file = processPath ? relative(root, processPath) : "";
  const shown = file.startsWith("..") ? processPath : file;
  const subtitle = [spec.root, shown, `read ${clock()}`].filter(Boolean).join(" · ");
  const work = workKind(spec);
  return { exit, out: renderStatus({ spec, report, view, work, subtitle, tty: tty() }) };
}
