// merge/record — the land's last two steps (plan R1b-5): `record` writes the lifecycle's `merged` event
// to the board (exec's carried writes put back first) and stops on a new `board check` finding;
// `commit` makes the one board commit of exactly those files, through the repo's own hooks.
import { applyEvent } from "../../process/lifecycle.mjs";
import { readProcess } from "../../process/read.mjs";
import { boardReport } from "../../process/status.mjs";
import { WriteError } from "../../process/write.mjs";
import { applyPatch } from "../carry-io.mjs";
import { boardCommit, restoreFiles, subjectOf } from "../land.mjs";
import { dropNext } from "./carry.mjs";
import { now, ok, red, save, setMerge, short, skip } from "./lane.mjs";

// A finding is "new" when its rule fails for an item it did not fail for before the board write. The
// message is not part of it (it often quotes the status the write just changed); a problem with no item
// is keyed by its message.
const findingKey = (f) =>
  JSON.stringify([f.rule ?? null, f.kind ?? null, f.id ?? null, f.id ? null : f.message]);
// A stop that put the board back as it was: the land is gated again, and resumes from there.
const unrecorded = (lane, stop) => {
  setMerge(lane, { step: "gated" });
  return stop;
};

export function recordStep(lane, rows) {
  const { root, spec, id } = lane;
  const merge = lane.ledger.merge;
  lane.files = [];
  if (!spec.lifecycle) {
    rows.push(skip("record", "lifecycle off: nothing written to the board"));
    return null;
  }
  // Written before the first board write: a rerun after a kill from here on looks for this land's
  // board commit, or takes its uncommitted board writes back (merge/recover.mjs).
  setMerge(lane, { step: "recording" });
  const carried = merge.carry?.files ?? [];
  if (merge.carry) {
    // Exec's writes go back first, on top of the picks, so the merged write and the check see them.
    const back = applyPatch(root, merge.carry.patch);
    if (!back.ok) {
      rows.push(
        red("record", `exec's board writes do not apply on top of the picks: ${back.reason}`, [
          `they stay in the ledger (merge.carry: ${carried.join(", ")})`,
        ]),
      );
      return unrecorded(lane, { exit: 1, next: dropNext(lane) });
    }
  }
  const model = readProcess({ root, spec });
  const before = new Set(boardReport({ root, spec, model }).findings.map(findingKey));
  const summary = lane.opts["--summary"] ?? subjectOf(root, merge.landed[0]);
  let result;
  try {
    result = applyEvent({
      root,
      spec,
      model,
      event: "merged",
      id,
      data: { shas: merge.landed, summary },
    });
  } catch (error) {
    if (!(error instanceof WriteError)) throw error;
    restoreFiles(root, carried); // the carry goes back as it was, at the stop
    rows.push(red("record", error.message));
    const next = "fix what it names, then land again (the picks stay; it resumes)";
    return unrecorded(lane, { exit: 1, next });
  }
  lane.files = [...new Set([...result.writes.map((w) => w.file), ...carried])];
  const after = boardReport({ root, spec, model: readProcess({ root, spec }) });
  const fresh = after.findings.filter((f) => !before.has(findingKey(f)));
  if (fresh.length > 0) {
    const back = restoreFiles(root, lane.files);
    const restored = back.ok ? "the written files are restored" : `restore failed: ${back.reason}`;
    rows.push(
      red(
        "record",
        `board check: ${fresh.length} new finding(s) after the board write; ${restored}`,
        fresh.map((f) => `${f.rule} ${f.id ?? ""} ${f.message}`),
      ),
    );
    const next = "fix what the finding names, then land again (the picks stay; it resumes)";
    return unrecorded(lane, { exit: 1, next });
  }
  const more = [
    ...result.writes.map((w) => `${w.file}: ${w.what}`),
    ...result.skipped.map((s) => `skipped ${s.what}: ${s.why}`),
  ];
  if (carried.length > 0) more.push(`carried, uncommitted until now: ${carried.join(", ")}`);
  rows.push(
    ok("record", `${result.writes.length} board write(s); board check: no new findings`, more),
  );
  return null;
}

export function commitStep(lane, rows) {
  const { root, files } = lane;
  const merge = lane.ledger.merge;
  if (files.length === 0) {
    save(lane, {
      state: "merged",
      merge: { ...merge, step: "committed", boardCommit: null, at: now() },
    });
    rows.push(skip("commit", "nothing written to the board, nothing to commit"));
    return null;
  }
  const res = boardCommit(root, { files, message: lane.opts["--message"] });
  if (!res.ok) {
    const back = restoreFiles(root, files);
    const [head, ...rest] = res.reason.split("\n");
    rows.push(
      red("commit", head, [
        ...rest.slice(0, 10),
        back.ok ? "the board files are restored" : `restore failed: ${back.reason}`,
      ]),
    );
    const next = "fix the message or what the hook names, then land again (it resumes)";
    return unrecorded(lane, { exit: 1, next });
  }
  // The carried board writes are in this commit now: the ledger lets go of them.
  save(lane, {
    state: "merged",
    merge: { ...merge, carry: undefined, step: "committed", boardCommit: res.sha, at: now() },
  });
  if (res.left.length > 0) {
    rows.push(
      red(
        "commit",
        `${short(res.sha)} committed, but main is not clean after it`,
        res.left.slice(0, 10),
      ),
    );
    return { exit: 1, next: "look at what the commit left behind (a hook that writes files?)" };
  }
  rows.push(
    ok("commit", `${short(res.sha)} ${subjectOf(root, res.sha)}`, [`files: ${files.join(", ")}`]),
  );
  return null;
}
