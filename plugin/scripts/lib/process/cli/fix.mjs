// board fix [--accept <id>] [--apply] [--json] — write what is provable, report the rest (A23, A31; plan
// R1b-6). A task whose `lane merge` record still holds on main (`drift.mechanical`: it matches its branch,
// its landed commits are main's first-parent history and their change is still in effect where it landed)
// and whose board row lacks the done status, the commit cell or the handoff line gets the lifecycle's
// `merged` event narrowed to those missing steps, through `applyEvent`, in one write: a step the board
// already has (a hand-written cell, a handoff line `board check` accepts) is never written again. A merge
// with no record is never written on its own: it stays a `merged-by-hand` nudge until the owner confirms
// it with `--accept <id>`, which writes it only while the commits carrying it are still in effect on main
// (`drift.accepted`). Anything unsure writes nothing and is listed, as is every other drift, with the
// command that deals with it. The output lists exactly the writes made; running it again finds nothing to
// do; without `--apply` it writes nothing and says what it would fix (A39). A row wider than 80 columns
// wraps between words: a command is never cut.
//
// run(argv, { root, spec, model }) -> { exit, out }   exit 0 = nothing left for the owner, 1 = items left
// to report, 2 = usage
import { basename } from "node:path";
import { PREVIEW, usageError } from "../../cli/help.mjs";
import { accepted, mechanical, nudges } from "../drift.mjs";
import { mainRoot } from "../git.mjs";
import { boardId } from "../ids.mjs";
import { applyEvent } from "../lifecycle.mjs";
import { readProcess } from "../read.mjs";
import { wrapText } from "../render.mjs";
import { titleOf } from "../status.mjs";
import { WriteError } from "../write.mjs";

export const help = {
  usage: "fix [--accept <id>] [--apply] [--json]",
  purpose:
    "Write the board cells a lane merge record proves (done, commit, handoff); list the rest.",
  args: {},
  flags: {
    "--apply": "write the fixes (without: say what it would fix, and write nothing)",
    "--accept <id>": "a task the owner says was merged by hand: fix it while its commits hold",
    "--json": "print { applied, fixed, left, nudges } as one JSON object",
  },
  exits: { 0: "nothing left for the owner", 1: "items left for the owner", 2: "usage" },
  example: "board fix --accept T-4 --apply",
};
const WIDTH = 80;

// The id `--accept` names: undefined when it is not given, null when it is given without one.
function acceptOf(argv) {
  const at = argv.indexOf("--accept");
  if (at < 0) return undefined;
  const id = argv[at + 1];
  return id && !id.startsWith("-") ? id : null;
}

// The process file with the lifecycle writing only `need`: the steps it drops are skipped by `applyEvent`.
const narrowed = (spec, need) => ({
  ...spec,
  lifecycle: {
    ...spec.lifecycle,
    write: Object.fromEntries(need.map((step) => [step, spec.lifecycle.write[step]])),
  },
});

export function run(argv, { root, spec, model }) {
  const dryRun = !argv.includes("--apply");
  const typed = acceptOf(argv);
  if (typed === null) return usageError("board fix", "--accept needs a task id");
  const id = typed && spec.lifecycle ? boardId(spec, model, typed, spec.lifecycle.kind) : typed;
  const runRoot = mainRoot(root) ?? root;
  const plan = mechanical({ root, runRoot, spec, model });
  if (id !== undefined && !plan.fixes.some((f) => f.id === id)) {
    const own = accepted({ root, runRoot, spec, model, id });
    plan.fixes.push(...own.fixes);
    plan.left.push(...own.left);
  }
  const fixed = [];
  const left = [...plan.left];
  let board = model;
  for (const f of plan.fixes) {
    const item = (Object.hasOwn(board.index, f.id) ? board.index[f.id] : []).find(
      (i) => i.kind === spec.lifecycle.kind,
    );
    const entry = { id: f.id, need: f.need, sha: f.shas[0].slice(0, 7) };
    if (dryRun) {
      fixed.push(entry);
      continue;
    }
    try {
      const summary = (item && titleOf(spec, item)) || f.id;
      const { writes } = applyEvent({
        root,
        spec: narrowed(spec, f.need),
        model: board,
        event: "merged",
        id: f.id,
        data: { shas: f.shas, summary },
      });
      if (writes.length) fixed.push({ ...entry, writes: writes.map((w) => w.what) });
      board = readProcess({ root, spec }); // the next task is edited against what is on disk now
    } catch (e) {
      if (!(e instanceof WriteError)) throw e;
      left.push(`${f.id}: not fixed (${e.message})`);
    }
  }
  const after = dryRun ? model : board;
  // The task `--accept` names is this run's own business: fixed (or would be) or in `left`.
  const rest = nudges({ root, runRoot, spec, model: after }).filter((n) => !id || n.id !== id);
  const exit = left.length || rest.length ? 1 : 0;
  if (argv.includes("--json"))
    return { exit, out: JSON.stringify({ applied: !dryRun, fixed, left, nudges: rest }) };
  return { exit, out: render({ dryRun, fixed, left, rest }) };
}

// One row: as it is while it fits, else broken between words with the rest indented.
function rows(text) {
  if ([...text].length <= WIDTH - 2) return [`  ${text}`];
  return wrapText(text, WIDTH - 2, WIDTH - 4).map((l, i) => `${i ? "    " : "  "}${l}`);
}

function render({ dryRun, fixed, left, rest }) {
  const verb = dryRun ? "would fix" : "fixed";
  const head = `${verb} ${fixed.length}, ${left.length + rest.length} left for you`;
  const lines = [head];
  for (const f of fixed) {
    const what = f.writes ? f.writes.join(", ") : `${f.need.join(", ")} from commit ${f.sha}`;
    lines.push(...rows(`${f.id}  ${what}`));
  }
  if (left.length + rest.length) lines.push("left for you:");
  for (const text of left) lines.push(...rows(text));
  for (const n of rest) {
    const subject = n.id ?? basename(n.path ?? n.branch ?? "");
    lines.push(...rows(`${n.kind} ${subject} → ${n.command}`));
  }
  if (dryRun && fixed.length) lines.push(PREVIEW);
  return lines.join("\n");
}
