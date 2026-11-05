// exec/admission — whether a lane may open or a builder go out: the `lanes.maxWriters` cap, a land
// in progress on main, a ledger already there for the id; the worktrees nested in a lane's own; and
// the owned files a new lane shares with a running one, as warnings.
import { isAbsolute, join, relative } from "node:path";
import { prefix } from "../../cli/invoke.mjs";
import { readConfig } from "../../config.mjs";
import { worktrees } from "../../process/git.mjs";
import { isKept } from "../../process/keep.mjs";
import * as ledgers from "../../process/ledger.mjs";
import { shellQuote as q } from "../brief.mjs";
import { clock } from "../exec-view.mjs";
import { isAncestor } from "../land.mjs";
import { OVERLAP_SHOWN, ownsPath } from "./guard/allow.mjs";
import { headOf } from "./guard/snapshot.mjs";
import { LANE, laneLine, ownedOf, refuse } from "./lane.mjs";

// Is `path` strictly inside the directory `dir`?
const inside = (dir, path) => {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

// The worktrees inside the lane's own worktree (a nested builder, #7): nothing else. A worktree made
// elsewhere while the lane ran (the conductor's own) is not the lane's.
export function nestedTrees(root, ledger) {
  const seen = worktrees(root)
    .map((t) => t.path)
    .filter((p) => inside(ledger.worktree, p));
  return [...new Set([...(ledger.nested ?? []), ...seen])];
}

// The lanes that count against `lanes.maxWriters`: open ledgers that build or fix, and worktrees no
// ledger owns, except the ones the repo keeps on purpose (`worktrees.keep`) and the host's own agent
// worktrees (`.claude/worktrees/`), which no lane started. `except` is a lane a restart replaces;
// `adopting` the worktree an adopt takes in. A worktree a lane adopted is that lane's.
function writers(root, spec, except = null, adopting = null) {
  const all = ledgers.list(root);
  const owned = new Set([
    ...all.map((l) => l.worktree),
    ...all.map((l) => l.adopted?.worktree).filter(Boolean),
    ...(adopting ? [adopting] : []),
  ]);
  const agents = join(root, ".claude", "worktrees");
  return [
    ...all
      .filter((l) => (l.state === "building" || l.state === "fixing") && l.id !== except)
      .map((l) => `${l.id} (${l.state}, ledger ${l.worktree})`),
    ...worktrees(root)
      .filter(
        (t) => t.path !== root && !owned.has(t.path) && !isKept(spec, t) && !inside(agents, t.path),
      )
      .map((t) => `${t.path} (${t.branch ?? "detached"}, no ledger)`),
  ];
}

// `start`, `restart` (its own lane not counted), `adopt` (the worktree it takes in not counted) and a
// `resume` that sends a builder are refused while `lanes.maxWriters` writers are open.
export function refuseAtWriterCap(root, spec, except = null, adopting = null) {
  const config = readConfig(root);
  if (config.error) refuse(config.error);
  const open = writers(root, spec, except, adopting);
  if (open.length >= config.lanes.maxWriters)
    refuse(
      `${open.length} writer(s) open, lanes.maxWriters is ${config.lanes.maxWriters}; finish or merge one first:\n${open.map((w) => `  ${w}`).join("\n")}`,
    );
}

// Are a land's picks on main: every commit it landed, or while it picks with none recorded yet, a commit
// past its preHead?
function picksOnMain(root, merge) {
  if (typeof merge?.preHead !== "string") return false;
  const landed = Array.isArray(merge.landed) ? merge.landed : [];
  if (landed.length) return landed.every((sha) => isAncestor(root, sha, "HEAD"));
  return (
    merge.step === "picking" &&
    headOf(root) !== merge.preHead &&
    isAncestor(root, merge.preHead, "HEAD")
  );
}

// A lane cut while another lands could carry picks a red gate then takes off main (S24): `start` waits.
export function refuseMidLand(root) {
  const landing = ledgers
    .list(root)
    .find((l) => l.state === "merging" && picksOnMain(root, l.merge));
  if (landing)
    refuse(
      landing.merge.cut
        ? `main is mid-land (${landing.id}, since ${clock(landing.merge.at)}): a cut of it stopped there → ${prefix("lane", `node ${q(LANE)}`)} exec cut ${landing.id} --decision <D> --apply rolls it back`
        : `main is mid-land (${landing.id}, since ${clock(landing.merge.at)}): its picks may still roll back → start after it lands, or ${prefix("lane", `node ${q(LANE)}`)} merge ${landing.id} --resolve landed|rolled-back`,
    );
}

// The owned files `owned` shares with a running lane (not merged or closed), as warning lines: `! owns
// overlap with R1c-4: plugin/commands/go.md`. A pair overlaps when one entry covers the other; the
// narrower of the two is named. A running lane whose owned files can't be read is skipped. The lanes of a
// stacked lane's `chain` (its parent first) land before it: what it shares with them is one line,
// `stack: shares with T1: a.txt, b.txt`.
export function ownsOverlap(root, owned, chain = []) {
  const mine = owned.map((o) => o.path);
  const lines = [];
  const stacked = new Set();
  for (const lane of ledgers.list(root)) {
    if (lane.state === "merged" || lane.state === "closed") continue;
    let theirs;
    try {
      theirs = ownedOf(root, lane).map((o) => (typeof o === "string" ? o : o.path));
    } catch {
      continue;
    }
    const shared = new Set();
    for (const a of mine)
      for (const b of theirs) {
        if (ownsPath(a, b)) shared.add(b);
        else if (ownsPath(b, a)) shared.add(a);
      }
    if (!shared.size) continue;
    if (chain.includes(lane.id)) {
      for (const p of shared) stacked.add(p);
      continue;
    }
    const names = [...shared];
    const more = names.length - OVERLAP_SHOWN;
    lines.push(
      `! owns overlap with ${lane.id}: ${names.slice(0, OVERLAP_SHOWN).join(", ")}${more > 0 ? ` (+${more} more)` : ""}`,
    );
  }
  if (stacked.size) {
    const names = [...stacked];
    const more = names.length - OVERLAP_SHOWN;
    lines.push(
      `stack: shares with ${chain[0]}: ${[...names.slice(0, OVERLAP_SHOWN), ...(more > 0 ? [`+${more}`] : [])].join(", ")}`,
    );
  }
  return lines.join("\n");
}

// `start` and `adopt` cut a new lane: refused while a ledger for `id` is there.
export function refuseLane(root, id) {
  const existing = (() => {
    try {
      return ledgers.read(root, id);
    } catch (e) {
      return refuse(e.message);
    }
  })();
  if (existing)
    refuse(
      `a lane for ${id} exists (state ${existing.state}, next ${existing.next}): ${laneLine(root, "show", id)}`,
    );
}
