// merge/stack — the `stack` rows of a land (A45): a stacked lane lands only after its parent, and only once
// restacked onto main (`stackRows`, the child's side); a parent's land names the lanes stacked on it
// (`childRows`, the parent's side). A stack stop changes nothing: main, the ledger and `merge` as they were.
//
// stackRows(lane) -> { rows, stop: null | { next } }
// childRows(lane, outcomes?) -> [row]   outcomes: { <child id>: { restacked } | { conflict } | { left } }
import * as ledgers from "../../process/ledger.mjs";
import { childrenOf, stackOf } from "../stack.mjs";
import { ok, red, short, skip, warn } from "./lane.mjs";

/** The child's side: red with the step that clears it while the lane is stacked, a tick after its restack
 *  onto main, nothing for a lane never stacked. */
export function stackRows(lane) {
  const { root, ledger } = lane;
  const id = ledger.id;
  const all = ledgers.list(root);
  if (!ledger.on) {
    const last = ledger.restacks?.findLast((r) => r.onto === "main");
    if (!last) return { rows: [], stop: null };
    const parent = all.find((l) => l.id === last.parent);
    const after =
      parent?.state === "merged"
        ? `after ${last.parent} landed`
        : `off ${last.parent} (${last.parent} is ${parent?.state ?? "gone"})`;
    return {
      rows: [ok("stack", `restacked onto main ${after} (${short(last.from)} → ${short(last.to)})`)],
      stop: null,
    };
  }
  const { on, due, state } = stackOf(root, ledger, all);
  const stop = (row, next) => ({ rows: [row], stop: { next } });
  if (due === "main") {
    const merge = all.find((l) => l.id === on)?.merge;
    return stop(
      red(
        "stack",
        `${on} landed (${merge?.landed?.length ?? 0} commit(s), board ${short(merge?.boardCommit)}); ${id} is still cut from ${on}'s old tip ${short(ledger.base)}`,
      ),
      `lane exec restack ${id}`,
    );
  }
  if (due === "orphan")
    return stop(
      red("stack", `${on} is ${state}: ${id} lands only after it`),
      `lane exec restack ${id} --main`,
    );
  return stop(
    red(
      "stack",
      `${id} is stacked on ${on}, which is not merged (${on} is ${state}): land ${on} first`,
    ),
    `lane merge ${on} --preflight`,
  );
}

/**
 * The parent's side. Before its land: `· stack   stacked on <id>: <ids>`. After a land that reached its
 * board commit, one row per open child: what its restack onto main did (`outcomes`, the land's own), else
 * that it still has to be restacked before its gate. No children, no rows.
 */
export function childRows(lane, outcomes = null) {
  const { root, id, ledger } = lane;
  const kids = outcomes ? Object.keys(outcomes).sort() : childrenOf(ledgers.list(root), id);
  if (!kids.length) return [];
  if (ledger.state !== "merged") return [skip("stack", `stacked on ${id}: ${kids.join(", ")}`)];
  return kids.map((x) => {
    const got = outcomes?.[x] ?? {};
    if (got.restacked !== undefined)
      return ok("stack", `restacked: ${x} onto main (${got.restacked} commits)`);
    if (got.conflict !== undefined)
      return warn(
        "stack",
        `restack ${x}: conflict in ${got.conflict ?? "?"} → lane exec restack ${x} --main`,
      );
    return warn(
      "stack",
      `${x} is stacked on ${id}: lane exec restack ${x} before its gate`,
      got.left ? [got.left] : [],
    );
  });
}
