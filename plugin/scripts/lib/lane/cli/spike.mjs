// lane spike [<branch|path> --for <id> | --keep "<why>" | --forget] [--json] — file an agent worktree no ledger
// knows (field 87), by its branch or its path, in `.agentry/run/spikes.json` (`spikes.mjs`): `--for <id>` is
// work meant for that board item, `--keep "<why>"` keeps it on purpose, `--forget` drops the entry. With no
// flag it lists the filed spikes, a branch gone since shown as `gone`. A local run-state write, not a board
// write: the registration flags write at once, no `--apply`. Refuses an unknown branch or path, the main
// checkout, a branch a ledger tracks (a lane's own, or one an open lane adopted), a branch with a case twin
// or no commits yet (by its name or its worktree's path alike), an id the board does not hold, a `--keep`
// reason of more than one line, and `--for` with `--keep`. A ledgerless `agentry/` worktree is filed like
// any other.
// Exit 0 = filed, forgotten or listed; 2 = usage or refusal (nothing written).
//
// run(argv, { root, spec, model }) -> { exit, out }
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { refuse, usageError } from "../../cli/help.mjs";
import { branchTips, worktrees } from "../../process/git.mjs";
import { runId } from "../../process/ids.mjs";
import { list as listLedgers } from "../../process/ledger.mjs";
import { isBranch, resolveBranch, shownName, strayTree, unnamedHead } from "../adopt.mjs";
import { fileSpike, forgetSpike, readSpikes, spikesFile } from "../spikes.mjs";
import { mainRoot } from "../worktree.mjs";

export const help = {
  usage: 'spike [<branch|path> --for <id> | --keep "<why>" | --forget] [--json]',
  purpose:
    "File an agent worktree no ledger knows as work for a board item or kept on purpose; with no flag, list them.",
  args: { "<branch|path>": "the worktree's branch, or its path" },
  flags: {
    "--for <id>": "the work is meant for that board item: drift shows how to land or continue it",
    "--keep <why>": "the worktree is kept on purpose, for that reason: shown as kept, never drift",
    "--forget": "drop the worktree's entry",
    "--json": "print { spikes } (and filed or forgot) as one JSON object",
  },
  exits: { 0: "filed, forgotten or listed", 2: "usage or refusal (nothing written)" },
  example: "lane spike worktree-agent-a1 --for T-4",
};

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

// argv → { target, forId, keep, forget, json } or { error }.
function parse(argv) {
  const words = [];
  const given = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!["--for", "--keep", "--forget", "--json"].includes(arg)) {
      words.push(arg);
      continue;
    }
    if (Object.hasOwn(given, arg)) return { error: `${arg} is given twice` };
    given[arg] = true;
    if (arg === "--for" || arg === "--keep") {
      given[arg] = argv[++i];
      if (given[arg] === undefined || given[arg].startsWith("--"))
        return { error: `${arg} needs a value` };
    }
  }
  const picked = ["--for", "--keep", "--forget"].filter((f) => Object.hasOwn(given, f));
  if (picked.length > 1) return { error: `${picked.join(" and ")} go one at a time` };
  if (words.length > 1) return { error: `one branch or path, not ${words.length}` };
  if (picked.length && !words.length) return { error: `${picked[0]} needs <branch|path>` };
  if (!picked.length && words.length)
    return { error: `${shownName(words[0])}: give --for <id>, --keep "<why>" or --forget` };
  if (given["--keep"] !== undefined && !given["--keep"].trim())
    return { error: "--keep needs the reason" };
  if (given["--keep"] !== undefined && /\p{Cc}/u.test(given["--keep"]))
    return { error: "--keep takes a one-line reason: no newline or other control character" };
  return {
    target: words[0] ?? null,
    forId: given["--for"] ?? null,
    keep: given["--keep"] ?? null,
    forget: Boolean(given["--forget"]),
    json: Boolean(given["--json"]),
  };
}

// The worktree `target` names: the one on that branch, else the one at that path. null when none does.
function treeNamed(all, target) {
  return (
    all.find((t) => t.branch === target) ?? all.find((t) => real(t.path) === real(target)) ?? null
  );
}

// Whether no branch of `tips` has `branch`'s name in any case: a worktree whose HEAD is on it is on a
// branch with no commits yet, not on another spelling of a branch.
const inNoCase = (branch, tips) => {
  const folded = branch.toLowerCase();
  return ![...tips.keys()].some((b) => b.toLowerCase() === folded);
};
const noCommits = (branch) => `${branch} has no commits yet: commit on it, then file it`;

// A reason as a listing shows it: in quotes, on one line.
const quoted = (text) => (shownName(text) === String(text) ? `"${text}"` : shownName(text));

// The board item `typed` names, any case, of a kind the lanes run: its id, or null when the board holds none.
function itemId({ spec, model }, typed) {
  const found = runId(spec, model, typed);
  if (found.error) return null;
  return model.kinds[found.kind]?.items.some((i) => i.id === found.id) ? found.id : null;
}

export function run(argv, ctx) {
  const { target, forId, keep, forget, json, error } = parse(argv);
  if (error) return usageError("lane spike", error);
  const root = mainRoot(ctx.root) ?? ctx.root;
  const what = target ? `lane spike ${shownName(target)}` : "lane spike";
  const read = readSpikes(root);
  if (read.error) return refuse(what, read.error);
  if (!target) return listed(root, read.spikes, json);
  if (forget) {
    const known = read.spikes.find((s) => s.branch === target || real(s.path) === real(target));
    if (!known) return refuse(what, "no spike is filed by that branch or path", "lane spike");
    const spikes = written(() => forgetSpike(root, known));
    if (spikes.error) return refuse(what, spikes.error);
    return shown(root, spikes, json, { forgot: known }, `forgot ${known.branch}`);
  }
  // A name that is no path must be a branch's own name, never a revision such as `b~0`, nor one with a
  // case twin.
  const tips = branchTips(root);
  const named = existsSync(target) ? null : resolveBranch(root, target, tips);
  const all = worktrees(root);
  if (named?.missing)
    return all.some((t) => t.branch === target) && inNoCase(target, tips)
      ? refuse(what, noCommits(target))
      : refuse(what, "that is no branch and no path", "git worktree list");
  if (named?.problem) return refuse(what, named.problem);
  const tree = treeNamed(all, target);
  // A worktree on a spelling of its branch that no branch is named is filed by no name that lasts.
  const stray = tree ? null : named && strayTree(all, target, tips);
  if (stray) return refuse(what, unnamedHead(stray));
  if (!tree)
    return refuse(what, "no worktree is on that branch or at that path", "git worktree list");
  if (real(tree.path) === real(root)) return refuse(what, "that is the main checkout, not a spike");
  if (!tree.branch)
    return refuse(
      what,
      `the worktree at ${tree.path} is on no branch: a spike is filed by its branch`,
    );
  if (!tips.has(tree.branch))
    return refuse(what, inNoCase(tree.branch, tips) ? noCommits(tree.branch) : unnamedHead(tree));
  // By its path too, the branch is a branch's own name with no case twin, as by its name.
  const own = named ?? resolveBranch(root, tree.branch, tips);
  if (own.problem) return refuse(what, own.problem);
  const lane = listLedgers(root).find(
    (l) =>
      l.branch === tree.branch ||
      (l.state !== "merged" && l.state !== "closed" && l.adopted?.branch === tree.branch),
  );
  if (lane) return refuse(what, `${tree.branch} is ${lane.id}'s lane: its ledger tracks it`);
  let id = null;
  if (forId !== null) {
    id = itemId(ctx, forId);
    if (!id)
      return refuse(
        what,
        `--for ${shownName(forId)}: the board holds no such item`,
        "agentry board status",
      );
  }
  const entry = {
    branch: tree.branch,
    path: tree.path,
    ...(id ? { for: id } : { keep }),
    at: new Date().toISOString(),
  };
  const spikes = written(() => fileSpike(root, entry));
  if (spikes.error) return refuse(what, spikes.error);
  const why = id ? `for ${id}` : `kept: ${quoted(keep)}`;
  return shown(root, spikes, json, { filed: entry }, `filed ${entry.branch} ${why}`);
}

// The list a spikes.json write leaves, or `{ error }`, one line, when the write throws: a file that cannot
// be written, or one the write refuses (`spikes.mjs`: an unusable file, a spike with open owner calls).
function written(write) {
  try {
    return write();
  } catch (e) {
    return { error: String(e?.message ?? e).split("\n")[0] };
  }
}

// Each spike with `gone` when its branch is no longer there (another case of it is not that branch).
const withGone = (root, spikes) => spikes.map((s) => ({ ...s, gone: !isBranch(root, s.branch) }));

function rows(spikes) {
  if (!spikes.length) return ["  none filed"];
  return spikes.map((s) => {
    const why = s.for ? `for ${shownName(s.for)}` : `kept: ${quoted(s.keep)}`;
    return `  ${s.branch} · ${why} · ${s.path}${s.gone ? " · gone" : ""}`;
  });
}

function listed(root, spikes, json) {
  const all = withGone(root, spikes);
  if (json) return { exit: 0, out: JSON.stringify({ spikes: all }) };
  return { exit: 0, out: [`spikes (${spikesFile(root)})`, ...rows(all)].join("\n") };
}

function shown(root, spikes, json, done, head) {
  const all = withGone(root, spikes);
  if (json) return { exit: 0, out: JSON.stringify({ ...done, spikes: all }) };
  return { exit: 0, out: [`${head} (${spikesFile(root)})`, ...rows(all)].join("\n") };
}
