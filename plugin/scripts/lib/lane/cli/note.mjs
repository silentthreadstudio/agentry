// lane note <id> [--owner "<call>" | --recorded <n,n|all> [--where "<file or section>"]] [--json] — the
// owner's calls on a lane or a spike (field 90, `owner-calls.mjs`). `--owner` appends one call (one line) to
// the open ledger of `<id>`, else to the spike filed `--for <id>`; `--recorded` marks calls as written down
// where the repo keeps decisions; with no flag it lists them. A local run-state write, not a board write: no
// `--apply`. Refuses, writing nothing: an item with no lane and no spike, an empty or multi-line call, a call
// number no holder has, and a ledger or `spikes.json` that cannot be read (named, never written over).
// Exit 0 = noted, marked or listed; 2 = usage or refusal.
//
// run(argv, { root, spec, model }) -> { exit, out }
import { refuse, usageError } from "../../cli/help.mjs";
import { idProblem } from "../../id.mjs";
import { runId } from "../../process/ids.mjs";
import { added, callProblem, holderName, holdersOf, marked, saveCalls } from "../owner-calls.mjs";
import { mainRoot } from "../worktree.mjs";

export const help = {
  usage:
    'note <id> [--owner "<call>" | --recorded <n,n|all> [--where "<file or section>"]] [--json]',
  purpose:
    "Record the owner's calls on a lane or a spike, mark them written down; with no flag, list them.",
  args: { "<id>": "the board item: its open lane, else the spike filed --for it" },
  flags: {
    "--owner <call>": "append one call, one line, as the owner made it",
    "--recorded <n,n|all>": "mark those calls (all: every one not written down) as written down",
    "--where <file or section>": "with --recorded: where the calls were written",
    "--json": "print { id, holders } (and noted or marked) as one JSON object",
  },
  exits: { 0: "noted, marked or listed", 2: "usage or refusal (nothing written)" },
  example: 'lane note T-4 --owner "keep the old flag for one release"',
};

const FLAGS = ["--owner", "--recorded", "--where"];

// argv → { id, owner, recorded, where, json } or { error }.
function parse(argv) {
  const words = [];
  const given = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      given.json = true;
      continue;
    }
    if (!FLAGS.includes(arg)) {
      words.push(arg);
      continue;
    }
    if (Object.hasOwn(given, arg)) return { error: `${arg} is given twice` };
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) return { error: `${arg} needs a value` };
    given[arg] = value;
  }
  if (words.length !== 1) return { error: words.length ? "one id at a time" : "needs <id>" };
  const owner = given["--owner"];
  const recorded = given["--recorded"];
  const where = given["--where"];
  if (owner !== undefined && recorded !== undefined)
    return { error: "--owner and --recorded go one at a time" };
  if (where !== undefined && recorded === undefined)
    return { error: "--where goes with --recorded" };
  if (where !== undefined && callProblem(where))
    return { error: "--where takes one line: the file or section" };
  let which;
  if (recorded !== undefined) {
    which = recorded === "all" ? "all" : recorded.split(",").map((n) => n.trim());
    if (which !== "all" && !which.every((n) => /^[1-9]\d*$/.test(n)))
      return { error: `--recorded takes call numbers (1,3) or all, not "${recorded}"` };
    if (which !== "all") which = [...new Set(which.map(Number))];
  }
  return { id: words[0], owner, which, where, json: Boolean(given.json) };
}

// The board's spelling of `typed` (any case, as every lane step reads it), or `{ error }`.
function itemId({ spec, model }, typed) {
  const problem = idProblem(typed);
  if (problem) return { error: problem };
  const found = runId(spec, model, typed);
  return found.error ? { error: found.error } : { id: found.id };
}

const stamp = () => new Date().toISOString();

export function run(argv, ctx) {
  const opts = parse(argv);
  if (opts.error) return usageError("lane note", opts.error);
  const found = itemId(ctx, opts.id);
  if (found.error) return usageError("lane note", found.error);
  const { id } = found;
  const what = `lane note ${id}`;
  const root = mainRoot(ctx.root) ?? ctx.root;
  if (opts.owner !== undefined) {
    const problem = callProblem(opts.owner);
    if (problem) return refuse(what, problem);
  }
  const res = holdersOf(root, id, { appending: opts.owner !== undefined });
  if (res.problem) return refuse(what, res.problem, res.next);
  if (opts.owner !== undefined) return note(root, id, res.holders[0], opts);
  if (opts.which !== undefined) return mark(root, id, res.holders, opts);
  return shown(id, res.holders, opts.json, {}, `calls of ${id}`);
}

function note(root, id, holder, { owner, json }) {
  const calls = added(holder.calls, owner, stamp());
  saveCalls(root, holder, calls);
  const call = calls.at(-1);
  const head = `noted call ${call.n} on ${holderName(holder)} of ${id}`;
  return shown(id, [{ ...holder, calls }], json, { noted: call }, head);
}

function mark(root, id, holders, { which, where, json }) {
  const res = marked(holders, which, { at: stamp(), where });
  if (res.problem) return refuse(`lane note ${id} --recorded`, res.problem, `lane note ${id}`);
  for (const { holder, calls } of res.writes) saveCalls(root, holder, calls);
  const now = holders.map((h) => res.writes.find((w) => w.holder === h)?.calls ?? h.calls);
  const after = holders.map((h, i) => ({ ...h, calls: now[i] }));
  const head = res.marked.length
    ? `marked ${res.marked.join(", ")} of ${id} as written down${where ? ` in ${where}` : ""}`
    : `nothing to mark: every call of ${id} is written down`;
  return shown(id, after, json, { marked: res.marked }, head);
}

// A holder as `--json` carries it: where it is and its calls, whole.
const holderJson = ({ on, file, branch, calls }) => ({
  on,
  ...(on === "lane" ? { file } : { branch }),
  calls,
});

// One row per call: `n · at · recorded|not written down · text`.
function rows(holders) {
  return holders.flatMap((h) => [
    `${holderName(h)}${h.on === "lane" ? ` (${h.file})` : ""}:`,
    ...(h.calls.length
      ? h.calls.map(
          (c) => `  ${c.n} · ${c.at} · ${c.recorded ? "recorded" : "not written down"} · ${c.text}`,
        )
      : ["  none"]),
  ]);
}

function shown(id, holders, json, done, head) {
  if (json)
    return { exit: 0, out: JSON.stringify({ id, ...done, holders: holders.map(holderJson) }) };
  return { exit: 0, out: [head, ...rows(holders)].join("\n") };
}
