// merge/picks — the land's `land` step (plan R1b-5): the branch's commits cherry-picked onto main, as
// one argv call that is aborted on any stop. `merge.preHead` and `merge.planned` are written before the
// pick, and what landed is read from main's first-parent history since preHead, so a rerun after a kill
// knows which picks main holds.
import {
  cherryPick,
  commitOf,
  commitsBetween,
  landedSince,
  rollback,
  subjectOf,
} from "../land.mjs";
import { FRESH, now, ok, red, save, setMerge, short, tipOf } from "./lane.mjs";
import { commitsRow } from "./rows.mjs";

// The picks main holds since preHead, read from main itself, become `merge.landed`.
function recordLanded(lane, rows, detail) {
  const { root } = lane;
  const merge = lane.ledger.merge;
  const got = landedSince(root, merge);
  if (got.error || got.rest.length > 0) {
    const why = got.error ?? `${got.rest.length} planned commit(s) are not on it`;
    rows.push(red("land", `${lane.ledger.mainBranch} does not hold the planned picks: ${why}`));
    return { exit: 1, next: `show the owner git log --first-parent ${short(merge.preHead)}..HEAD` };
  }
  setMerge(lane, { step: "landed", landed: got.landed, stopped: undefined });
  const more = got.landed.map((sha) => `${short(sha)} ${subjectOf(root, sha)}`);
  rows.push(ok("land", `${got.landed.length} commit(s) ${detail} ${short(merge.preHead)}`, more));
  return null;
}

function pickStep(lane, rows) {
  const { root } = lane;
  const { mainBranch, branch } = lane.ledger;
  const { preHead, planned } = lane.ledger.merge;
  const res = cherryPick(root, { shas: planned, preHead });
  if (res.ok) return recordLanded(lane, rows, "picked onto");
  setMerge(lane, { step: res.restored ? "conflict" : "picking", stopped: res.stopped });
  const where = res.stopped ? ` on ${short(res.stopped)}` : "";
  rows.push(
    red("land", `cherry-pick stopped${where}: ${res.reason}`, [
      res.restored
        ? `aborted: ${mainBranch} is back at ${short(preHead)}, clean`
        : `aborted, but ${mainBranch} is NOT back at ${short(preHead)} and clean`,
    ]),
  );
  return res.restored
    ? { exit: 1, next: `ask the builder to rebase ${branch} onto ${mainBranch}, then land again` }
    : {
        exit: 1,
        keepCarry: true,
        next: `look at ${mainBranch} by hand (git status; git log ${short(preHead)}..HEAD), then land again`,
      };
}

// A run killed while picking: which planned commits main holds, read from main itself. All of them →
// landed; some → taken off again, so the picks start over as one sequence.
function resumePicking(lane, rows) {
  const { root } = lane;
  const merge = lane.ledger.merge;
  const got = landedSince(root, merge);
  if (got.error) {
    rows.push(
      red("land", `a killed land was picking onto ${short(merge.preHead)}: ${got.error}`, [
        "merge takes off only its own picks; it leaves anything else on main alone",
      ]),
    );
    return { exit: 1, next: `show the owner git log --first-parent ${short(merge.preHead)}..HEAD` };
  }
  if (got.rest.length === 0) return recordLanded(lane, rows, "a killed run had picked onto");
  if (got.landed.length > 0) {
    const back = rollback(root, { preHead: merge.preHead, landed: got.landed });
    if (!back.ok) {
      rows.push(red("land", `a killed land left ${got.landed.length} pick(s): ${back.reason}`));
      return { exit: 1, next: `show the owner git log ${short(merge.preHead)}..HEAD` };
    }
    rows.push(ok("land", `took off the ${got.landed.length} pick(s) a killed run made`));
  }
  setMerge(lane, { step: undefined });
  return landStep(lane, rows);
}

/** The `land` step: resume what the ledger says landed, or plan and pick the branch's commits. */
export function landStep(lane, rows) {
  const { root } = lane;
  const { mainBranch, state } = lane.ledger;
  const merge = lane.ledger.merge ?? {};
  if (merge.step === "picking") return resumePicking(lane, rows);
  if (!FRESH.includes(merge.step)) {
    const chain = commitsBetween(root, merge.preHead, "HEAD", { firstParent: true });
    if (chain?.join(" ") !== merge.landed.join(" ")) {
      const extra = (chain ?? []).filter((sha) => !merge.landed.includes(sha));
      rows.push(
        red(
          "land",
          `${mainBranch} has moved since this land picked ${merge.landed.length} commit(s) onto ${short(merge.preHead)}`,
          [
            ...extra
              .slice(0, 5)
              .map((sha) => `${short(sha)} ${subjectOf(root, sha)}: not this land's`),
            "merge resumes only while main is preHead plus its own picks",
          ],
        ),
      );
      return {
        exit: 1,
        next: `show the owner git log --first-parent ${short(merge.preHead)}..${mainBranch}`,
      };
    }
    rows.push(
      ok(
        "land",
        `${merge.landed.length} commit(s) already on ${mainBranch}: resuming`,
        merge.landed.map(short),
      ),
    );
    return null;
  }
  const { plan, row } = commitsRow(lane);
  if (row.mark === "red") {
    rows.push({ ...row, step: "land" });
    return { exit: 1 };
  }
  // The intent, written before main changes: what is picked onto what. The lane's state before this
  // land is kept too, given back if a red gate takes the picks off main again.
  const stateBefore = state === "merging" ? (merge.stateBefore ?? state) : state;
  const { carry, droppedCarries } = merge;
  save(lane, {
    state: "merging",
    merge: {
      carry,
      droppedCarries,
      preHead: commitOf(root, "HEAD"),
      planned: plan.picks,
      landed: [],
      tip: tipOf(lane),
      stateBefore,
      step: "picking",
      at: now(),
    },
  });
  return pickStep(lane, rows);
}
