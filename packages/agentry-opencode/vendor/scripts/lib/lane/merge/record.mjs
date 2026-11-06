// merge/record — the land's last two steps: `record` writes the lifecycle's `merged` event
// to the board (the owner's recorded board writes and exec's carried writes put back first) and stops on
// a new `board check` finding;
// `commit` makes the one board commit of exactly those files, through the repo's own hooks.
//
// What the record writes is worked out first, in a scratch copy of the board, and its sha256 per file
// goes to the ledger (`merge.record`) before main is touched: a rerun after a kill takes back, or takes
// as its board commit, only what matches it (merge/recover.mjs).
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { boardFiles } from "../../process/board-diff.mjs";
import { runDir } from "../../process/ledger.mjs";
import { applyEvent, findingKey } from "../../process/lifecycle.mjs";
import { readProcess } from "../../process/read.mjs";
import { boardReport } from "../../process/status.mjs";
import { WriteError } from "../../process/write.mjs";
import { putCells, sha256 } from "../carry-io.mjs";
import { boardCommit, commitOf, restoreFiles, subjectOf, textAt } from "../land.mjs";
import { backStop, carryWritesStep, putBackAllow, releaseWrites } from "./aside.mjs";
import { conflictLine, dropNext } from "./carry.mjs";
import { now, ok, red, save, setMerge, short, skip } from "./lane.mjs";

// A stop that put the board back as it was: the land is gated again, and resumes from there.
const unrecorded = (lane, stop) => {
  setMerge(lane, { step: "gated", record: undefined });
  return stop;
};

// The board as the record would leave it, worked out in a scratch copy under the run dir (inside the
// repo, so the lifecycle's git calls work there; the run dir is ignored): main's board as it is (the
// recorded board writes back on it), exec's carried cells set again, then the `merged` event. `{ texts:
// Map(file → text), bases: Map(file → main's text as copied), result }` for each file that changes, or
// `{ stop }` with its row pushed. Main is not touched.
function planRecord(lane, rows) {
  const { root, spec, id, kind } = lane;
  const merge = lane.ledger.merge;
  const carried = [...(merge.carry?.files ?? []), ...(merge.writes?.files ?? [])];
  const scratch = mkdtempSync(join(runDir(root, id), "record-"));
  const bases = new Map();
  try {
    const files = [...new Set([...boardFiles(spec, readProcess({ root, spec })), ...carried])];
    for (const file of files.filter((f) => existsSync(join(root, f)))) {
      mkdirSync(dirname(join(scratch, file)), { recursive: true });
      copyFileSync(join(root, file), join(scratch, file));
      bases.set(file, readFileSync(join(scratch, file), "utf8"));
    }
    if (merge.carry) {
      const back = putCells(scratch, spec, merge.carry.cells);
      if (!back.ok) {
        rows.push(
          red("record", "exec's board writes do not apply on top of the picks", [
            ...back.conflicts.map(conflictLine),
            ...(back.reason ? [back.reason] : []),
            `they stay in the ledger (merge.carry: ${merge.carry.files.join(", ")})`,
          ]),
        );
        return { stop: { exit: 1, next: dropNext(lane) } };
      }
    }
    const summary = lane.opts["--summary"] ?? subjectOf(root, merge.landed[0]);
    let result;
    try {
      const model = readProcess({ root: scratch, spec });
      const data = { shas: merge.landed, summary };
      result = applyEvent({ root: scratch, spec, model, event: "merged", id, kind, data });
    } catch (error) {
      if (!(error instanceof WriteError)) throw error;
      rows.push(red("record", error.message));
      const next = "fix what it names, then land again (the picks stay; it resumes)";
      return { stop: { exit: 1, next } };
    }
    const texts = new Map();
    for (const file of new Set([...result.writes.map((w) => w.file), ...carried])) {
      const text = readFileSync(join(scratch, file), "utf8");
      if (text !== textAt(root, "HEAD", file)) texts.set(file, text);
    }
    // A kind exec runs beside the lifecycle has no parent to hand off to.
    if (kind !== spec.lifecycle.kind)
      for (const s of result.skipped)
        if (s.what === "handoff") s.why = `no handoff: ${kind} is outside the tree`;
    return { texts, bases, result };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function recordStep(lane, rows) {
  const { root, spec } = lane;
  lane.files = [];
  if (!spec.lifecycle) {
    rows.push(skip("record", "lifecycle off: nothing written to the board"));
    return null;
  }
  // The board check's baseline: main's board as committed, before exec's writes or the merged write,
  // so a finding either one brings is new.
  const before = new Set(
    boardReport({ root, spec, model: readProcess({ root, spec }) }).findings.map(findingKey),
  );
  const writes = carryWritesStep(lane, rows);
  if (writes) return writes;
  const plan = planRecord(lane, rows);
  if (plan.stop) return plan.stop;
  const { texts, bases, result } = plan;
  const files = [...texts.keys()];
  const baseOf = (file) => (bases.has(file) ? bases.get(file) : textAt(root, "HEAD", file));
  const changed = files.filter((file) => readFileSync(join(root, file), "utf8") !== baseOf(file));
  if (changed.length > 0) {
    rows.push(
      red("record", `changed on main while the board write was worked out: ${changed.join(", ")}`),
    );
    return { exit: 1, next: "land again (it resumes)" };
  }
  // Written before the first board write: what this land writes, by sha256, so a rerun after a kill
  // from here on acts only on what it can prove is its own (merge/recover.mjs).
  const hashes = Object.fromEntries(files.map((file) => [file, sha256(texts.get(file))]));
  // `on`: the commit the board commit goes on, so a commit the land accepted after its gate (the owner's
  // board fix) is never taken for the land's own board commit.
  const on = commitOf(root, "HEAD");
  // `base`: what main held of a file before the write when that is not HEAD's (a recorded board write put
  // back), so a rerun after a kill knows that text as its own too; the ledger still holds the write.
  const base = Object.fromEntries(
    files
      .filter((file) => baseOf(file) !== null && baseOf(file) !== textAt(root, "HEAD", file))
      .map((file) => [file, sha256(baseOf(file))]),
  );
  setMerge(lane, { step: "recording", record: { files, sha256: hashes, base, on } });
  for (const file of files) writeFileSync(join(root, file), texts.get(file));
  lane.files = files;
  const merge = lane.ledger.merge;
  const carried = [...(merge.carry?.files ?? []), ...(merge.writes?.files ?? [])];
  const after = boardReport({ root, spec, model: readProcess({ root, spec }) });
  const fresh = after.findings.filter((f) => !before.has(findingKey(f)));
  if (fresh.length > 0) {
    const back = restoreFiles(root, files);
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
  if (files.length === 0) {
    const back = putBackAllow(lane);
    if (back) rows.push(back);
    const stop = backStop(back);
    if (stop) return stop;
    save(lane, {
      state: "merged",
      merge: {
        ...lane.ledger.merge,
        record: undefined,
        step: "committed",
        boardCommit: null,
        at: now(),
      },
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
  // The owner's guard.allow edits go back before the lane is "merged": a run killed in between finds them
  // in the ledger still. The carried board writes, the recorded ones too, are in this commit now: the
  // ledger lets go of them.
  if (lane.carriedWrites) releaseWrites(lane);
  const back = putBackAllow(lane);
  if (back) rows.push(back);
  // An old record stops here with the board commit made and the ledger still recording: the rerun proves
  // the commit (merge/recover.mjs) and stops on the record the same way until it is dropped.
  const stop = backStop(back);
  if (stop) return stop;
  save(lane, {
    state: "merged",
    merge: {
      ...lane.ledger.merge,
      carry: undefined,
      record: undefined,
      step: "committed",
      boardCommit: res.sha,
      at: now(),
    },
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
