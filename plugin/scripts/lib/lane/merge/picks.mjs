// merge/picks — the land's `land` step (plan R1b-5): the branch's commits cherry-picked onto main, as
// one argv call that is aborted on any stop. `merge.preHead` and `merge.planned` are written before the
// pick, and what landed is read from main's first-parent history since preHead, so a rerun after a kill
// knows which picks main holds.
import { posix } from "node:path";
import { escapesRoot } from "../../process/spec/shape.mjs";
import { globMatch } from "../gate.mjs";
import {
  cherryPick,
  commitOf,
  commitsBetween,
  filesOf,
  landedSince,
  rollback,
  subjectOf,
} from "../land.mjs";
import { isMemoryCommit } from "../own-memory.mjs";
import { FRESH, now, ok, red, save, setMerge, short } from "./lane.mjs";
import { commitsRow, listedTip } from "./rows.mjs";

// Twin of `boardPaths` in lane/cli/exec.mjs, kept in step with it until both move into one shared module.
// The board's own files as the lane's guard reads them (field 75): each kind's table,
// contract blocks and create blocks and `status.note` as paths, each kind's `at.files` and `file.glob` (its
// `{id}` any name) as globs, from the spec's root; one that leaves the repository is never one. A path
// test: (path) => boolean, for a repo-relative, `/`-separated path.
function boardPathTest(spec) {
  const base = typeof spec?.root === "string" ? spec.root : ".";
  if (!spec || escapesRoot(".", base)) return () => false;
  const inRepo = (from) => (p) => typeof p === "string" && p !== "" && !escapesRoot(from, p);
  const paths = [];
  const globs = [];
  for (const kind of Object.values(spec.kinds ?? {})) {
    paths.push(kind?.at?.table, ...[kind?.contract?.blocks ?? []].flat());
    paths.push(...[kind?.create?.blocks ?? []].flat().map((b) => b?.file));
    globs.push(kind?.at?.files, kind?.file?.glob?.replaceAll?.("{id}", "*"));
  }
  const fromBase = (list) =>
    list.filter(inRepo(base)).map((p) => posix.normalize(posix.join(base, p)));
  const note = spec.status?.note;
  const exact = new Set([
    ...fromBase(paths),
    ...(inRepo(".")(note) ? [posix.normalize(note)] : []),
  ]);
  const wild = fromBase(globs);
  return (path) => exact.has(path) || (wild.length > 0 && globMatch(wild, path));
}

// Agentry's own config at the root of `.agentry/` (process.json, workflow.json, config.json).
const AGENTRY_CONFIG = /^\.agentry\/[^/]+\.json$/;

// Does commit `sha` change only board files and Agentry's config (the owner's board fix after a stop)?
function boardOnlyCommit(lane, sha) {
  const files = filesOf(lane.root, sha);
  if (!files?.length) return false; // a merge commit, or git cannot say
  const board = boardPathTest(lane.spec);
  return files.every((file) => board(file) || AGENTRY_CONFIG.test(file));
}

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
  // An exec lane rebases through its own step, which then checks the resolution before the land.
  const rebase =
    lane.ledger.origin === "exec"
      ? `lane exec rebase ${lane.id}`
      : `ask the builder to rebase ${branch} onto ${mainBranch}, then land again`;
  return res.restored
    ? { exit: 1, next: rebase }
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
    // Main is preHead plus the picks. Once the gate passed, commits after them that only add Agentry's
    // memory records (the owner committing an episode), or change only board files and Agentry's config
    // (the owner's fix for a finding the record stopped on, field 79), may follow: they are no one's land,
    // nothing is rolled back over them any more, and the board commit goes on top.
    const chain = commitsBetween(root, merge.preHead, "HEAD", { firstParent: true });
    const n = merge.landed.length;
    const ownersOk = (sha, i) =>
      i >= n && merge.step === "gated" && (isMemoryCommit(root, sha) || boardOnlyCommit(lane, sha));
    const extra = (chain ?? []).filter(
      (sha, i) => !merge.landed.includes(sha) && !ownersOk(sha, i),
    );
    if (!chain || chain.slice(0, n).join(" ") !== merge.landed.join(" ") || extra.length > 0) {
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
    const owners = (chain ?? [])
      .slice(n)
      .map(
        (sha) =>
          `${short(sha)} ${subjectOf(root, sha)}: after the gate, not a pick; the board commit goes on top`,
      );
    rows.push(
      ok("land", `${merge.landed.length} commit(s) already on ${mainBranch}: resuming`, [
        ...merge.landed.map(short),
        ...owners,
      ]),
    );
    return null;
  }
  const { plan, row, next } = commitsRow(lane);
  if (row.mark === "red") {
    rows.push({ ...row, step: "land" });
    // A merge commit that brings in another lane's branch: that lane lands first.
    return next ? { exit: 1, next } : { exit: 1 };
  }
  // The intent, written before main changes: what is picked onto what. The lane's state before this
  // land is kept too, given back if a red gate takes the picks off main again.
  const stateBefore = state === "merging" ? (merge.stateBefore ?? state) : state;
  const { carry, droppedCarries, allow, writes } = merge;
  save(lane, {
    state: "merging",
    merge: {
      carry,
      droppedCarries,
      allow,
      writes,
      preHead: commitOf(root, "HEAD"),
      planned: plan.picks,
      landed: [],
      // The tip the plan was made from, as `ledgerStep` listed it: never read by name again.
      tip: listedTip(lane),
      stateBefore,
      step: "picking",
      at: now(),
    },
  });
  return pickStep(lane, rows);
}
