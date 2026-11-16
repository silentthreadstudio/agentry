// merge/owns-row — the `owns` row of the preflight (and, as a warning, of the land): the files the branch
// changed against what the lane's contract owns, as the guard reads it (`ownedOf`, with `owns --add`'s grants
// and the contract's globs). `merge.sidecars` (`.uid`, `.import`) counts a file as owned when the file it
// follows is, so an engine's generated companions are not "outside". The row names the files outside and the
// line that adds them; it never refuses a land.
import { ownsPath } from "../exec/guard/allow.mjs";
import { ownedOf } from "../exec/lane.mjs";
import { changedSince } from "../gate.mjs";
import { mergeBaseOf } from "../land.mjs";
import { ok, warn } from "./lane.mjs";
import { listedTip } from "./rows.mjs";

/** `✓ owns  N files inside owns`, or `! owns  K outside: a, b → lane exec owns <id> --add a,b`; null when the
 *  lane has no owned list to read (an adopted branch) or git cannot say what the branch changed. */
export function ownsRow(lane) {
  const { root, id, spec, ledger } = lane;
  const tip = listedTip(lane);
  const base = tip && mergeBaseOf(root, ledger.mainBranch, tip);
  const changed = base ? changedSince(root, base, tip) : null;
  if (!changed) return null;
  let entries;
  try {
    entries = ownedOf(root, ledger).map((o) => (typeof o === "string" ? o : o.path));
  } catch {
    return null;
  }
  const suffixes = spec.merge?.sidecars ?? [];
  const owned = (path) => entries.some((entry) => ownsPath(entry, path));
  const inside = (path) =>
    owned(path) || suffixes.some((s) => path.endsWith(s) && owned(path.slice(0, -s.length)));
  const outside = changed.filter((path) => !inside(path));
  if (outside.length === 0) return ok("owns", `${changed.length} files inside owns`);
  return warn(
    "owns",
    `${outside.length} outside: ${outside.join(", ")} → lane exec owns ${id} --add ${outside.join(",")}`,
  );
}
