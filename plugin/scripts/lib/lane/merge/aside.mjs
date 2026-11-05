// merge/aside — the files a land sets aside beside exec's carry and puts back uncommitted. The owner's
// own uncommitted edits to files `guard.allow` names (a status file, a plan) are not exec's writes and need
// no board cell, but the picks, the gate and the board commit all need a clean tree. So the land sets them
// aside the same way (the patch and its sha256 in `merge.allow`, recorded first), and puts them back after
// the board commit, at any stop, or first thing on the rerun of a killed land. An edit that no longer
// applies on the landed files is saved to a patch file and said, never lost. A new, untracked file under
// `guard.allow` is carried the same way (its patch is a new-file patch; set aside is deleting it), and so
// is a file only `agentry board add` / `board set --apply` changed, by the content ids they recorded
// (`merge.writes`, the same record plus the cells for a pick that touches the file). A new `guard.allow`
// file is never committed by the land: it goes back to the owner uncommitted. The recorded board writes
// are the owner's board record (field 79: a verdict the board check needs): they go back onto main at the
// start of the record, so the check sees them and the board commit holds them; with the lifecycle off
// there is no board commit, and they go back uncommitted. A record an older version wrote is
// `merge/legacy.mjs`'s.
import { writeFileSync } from "node:fs";
import { runDir } from "../../process/ledger.mjs";
import {
  applyPatch,
  asidePatch,
  nextPatchFile,
  planRows,
  putCells,
  removeFiles,
  sha256,
} from "../carry-io.mjs";
import { restoreFiles } from "../land.mjs";
import { landNext, now, ok, red, setMerge, warn } from "./lane.mjs";
import { OLD_LINE, isOld, oldRecord } from "./legacy.mjs";

// The two records of files set aside to be put back uncommitted: the owner's `guard.allow` edits and new
// files (`merge.allow`) and the files only board-script writes changed (`merge.writes`, with the cells a
// pick that touched the file is merged back by).
export const ALLOW = {
  key: "allow",
  noun: "guard.allow file(s)",
  edits: "guard.allow edits",
  patch: "merge-allow",
  after: "put back after the land",
  files: (lane) => lane.allowFiles ?? [],
  untracked: (lane) => lane.allowNew ?? [],
  cells: () => undefined,
  rows: () => undefined,
};
export const WRITES = {
  key: "writes",
  noun: "board-write file(s)",
  edits: "board writes",
  patch: "merge-writes",
  after: "put back for the board commit",
  files: (lane) => lane.writes?.files ?? [],
  untracked: () => [],
  cells: (lane) => lane.writes?.cells,
  rows: (lane) => lane.writes?.rows,
};

/** Record `kind`'s files in the ledger (the patch and its sha256), then set them aside: put back to HEAD,
 *  or deleted when HEAD does not hold them. */
export function takeAside(lane, rows, kind) {
  const files = kind.files(lane);
  if (files.length === 0) return null;
  const untracked = kind.untracked(lane);
  const made = asidePatch(lane.root, files, untracked);
  if (made.error) {
    rows.push(red(kind.key, `cannot read the ${kind.edits}: ${made.error}`));
    return { exit: 1 };
  }
  const [cells, added] = [kind.cells(lane), kind.rows(lane)];
  const cellsSha256 = cells && sha256(JSON.stringify([cells, added ?? []]));
  setMerge(lane, {
    [kind.key]: {
      enc: "bytes",
      files,
      untracked,
      patch: made.patch,
      sha256: made.sha256,
      cells,
      rows: added,
      cellsSha256,
      at: now(),
    },
  });
  const aside = restoreFiles(
    lane.root,
    files.filter((file) => !untracked.includes(file)),
  );
  const gone = aside.ok ? removeFiles(lane.root, untracked) : aside;
  if (!gone.ok) {
    rows.push(red(kind.key, `could not set the ${kind.edits} aside: ${gone.reason}`));
    return { exit: 1 };
  }
  rows.push(
    ok(kind.key, `${files.length} ${kind.noun} set aside, recorded in the ledger first`, [
      `${files.join(", ")}: sha256 ${made.sha256.slice(0, 12)}…, ${lane.spec.lifecycle ? kind.after : "put back after the land"}`,
    ]),
  );
  return null;
}

// Where an edit that cannot go back is kept: the first <name>-<n>.patch the run directory lacks.
function keepPatch(lane, name, patch) {
  const file = nextPatchFile(runDir(lane.root, lane.id), name);
  writeFileSync(file, patch, "latin1"); // the patch is bytes kept one per char
  return file;
}

/** Put the files `kind`'s record holds back onto main's working tree and let go of them. Edits already
 *  back (a run killed after it put them back) are left. A file a pick changed is merged back by cell when
 *  the record has its cells. Edits that no longer apply, or whose record fails its sha256, are saved to a
 *  patch file and said (a warning: the land is not undone for them, and nothing is lost). A row, or null
 *  when the ledger holds none. `hold`: the record is kept (the board commit lets go of it), and edits that
 *  do not go back are a red row, nothing saved: the stop's own put-back saves them. */
function putBackAside(lane, kind, { hold = false } = {}) {
  const held = lane.ledger.merge?.[kind.key];
  if (!held) return null;
  if (isOld(held))
    return hold ? red(kind.key, `${kind.edits}: ${OLD_LINE}`) : oldRecord(lane, kind, held);
  const files = held.files.join(", ");
  const [cells, added] = [held.cells ?? [], held.rows ?? []];
  const both = bothKinds(held);
  if (both) throw new Error(`carry: ${bothMessage(both)}`);
  const apply = (...flags) => applyPatch(lane.root, held.patch, ...flags);
  const intactRecord = sha256(held.patch) === held.sha256;
  const done = (row) => {
    if (!hold) setMerge(lane, { [kind.key]: undefined }); // only once the edits are on main or in a patch file
    return row;
  };
  if (intactRecord && apply("--reverse", "--check").status === 0)
    return done(ok(kind.key, `${kind.edits} are on main already (${files})`));
  if (intactRecord && apply().status === 0)
    return done(
      ok(kind.key, `${kind.edits} are on main again, uncommitted, as they were (${files})`),
    );
  // A file a pick or the board commit changed: set again by the cell ids and the rows' neighbours.
  const covered = held.files.every(
    (file) => cells.some((c) => c.file === file) || added.some((r) => r.file === file),
  );
  if (intactRecord && covered && sha256(JSON.stringify([cells, added])) === held.cellsSha256) {
    const plan = planRows(lane.root, lane.spec, added);
    const back = plan.ok ? putCells(lane.root, lane.spec, cells) : plan;
    if (back.ok) {
      plan.write();
      const how = [cells.length > 0 && "cell by cell", added.length > 0 && "row by row"];
      return done(
        ok(
          kind.key,
          `${kind.edits} are on main again, uncommitted, set ${how.filter(Boolean).join(" and ")} on the landed files (${files})`,
        ),
      );
    }
  }
  const why = intactRecord
    ? "they no longer apply to the landed files"
    : "the ledger's copy fails its sha256 check";
  if (hold)
    return red(kind.key, `${kind.edits} cannot go into the board commit (${files}): ${why}`);
  const file = keepPatch(lane, kind.patch, held.patch);
  return done(
    warn(kind.key, `${kind.edits} were not put back (${files}): ${why}`, [
      `your edits are saved in ${file}: look at them, then git apply it by hand`,
    ]),
  );
}

// The first file of `held` that has both recorded cells and added rows (never made by `scriptWrites`).
const bothKinds = (held) =>
  held.files.find(
    (file) =>
      (held.cells ?? []).some((c) => c.file === file) &&
      (held.rows ?? []).some((r) => r.file === file),
  );
const bothMessage = (file) => `${file} has both cells and rows; this is a bug, nothing was written`;

/** Does the ledger's `merge` hold a set-aside record written by an older version? `--drop-carry` drops it. */
export const hasOldRecord = (merge) =>
  [ALLOW, WRITES].some((kind) => merge?.[kind.key] && isOld(merge[kind.key]));
const DROP_CARRY = " --drop-carry";
const BUG_NEXT = "this is a bug: report it; nothing was changed";
/** The stop for a put-back row that refused (red: an old record, or a record that is a bug), else null.
 *  Its `next` is the refusing row's own; a row that names none gets the general line. */
export function backStop(back) {
  if (back?.mark !== "red") return null;
  const next = back.next ?? "show the owner the carry row: nothing was written or put back";
  return { exit: 2, keepCarry: true, next };
}

/** The record's first step: the recorded board writes (`merge.writes`) back onto main, the ledger keeping
 *  them, so the board check reads the board with them and the board commit holds them (field 79). A row
 *  per file; a stop when they do not go back (the stop's put-back then saves them, never lost). */
export function carryWritesStep(lane, rows) {
  const held = lane.ledger.merge?.writes;
  if (!held) return null;
  const back = putBackAside(lane, WRITES, { hold: true });
  if (back.mark === "red") {
    rows.push({ ...back, step: "carry" });
    return { exit: 1, next: "look at the kept patch the carry row names, then land again" };
  }
  lane.carriedWrites = true;
  for (const file of held.files)
    rows.push(ok("carry", `${file}: your recorded board write, carried into the board commit`));
  return null;
}

/** Let go of the recorded board writes once the board commit holds them. */
export const releaseWrites = (lane) => {
  if (lane.ledger.merge?.writes) setMerge(lane, { writes: undefined });
};

const WORST = ["red", "warn", "ok"];
/** Put back what the ledger holds of the owner's `guard.allow` files and of board-script writes: one
 *  row, or null when it holds none. An old record refuses (a red row, nothing put back) unless the owner
 *  passed `--drop-carry`. */
export function putBackAllow(lane) {
  const kinds = [ALLOW, WRITES];
  // A record that is a bug stops everything before the first one is put back.
  for (const kind of kinds) {
    const held = lane.ledger.merge?.[kind.key];
    const both = held && !isOld(held) && bothKinds(held);
    if (both) return { ...red("carry", bothMessage(both)), next: BUG_NEXT };
  }
  const old = kinds.filter(
    (kind) => lane.ledger.merge?.[kind.key] && isOld(lane.ledger.merge[kind.key]),
  );
  const refuse = old.length > 0 && !lane.opts?.["--drop-carry"];
  const rows = (refuse ? old : kinds).map((kind) => putBackAside(lane, kind)).filter(Boolean);
  if (rows.length === 0) return null;
  const [first, ...rest] = rows;
  const mark = WORST.find((m) => rows.some((r) => r.mark === m));
  const next = refuse
    ? `restore the kept patch by hand, then ${landCommand(lane)}${DROP_CARRY}`
    : undefined;
  return {
    ...first,
    mark,
    next,
    more: [...first.more, ...rest.flatMap((r) => [r.detail, ...r.more])],
  };
}

const SAFE_WORD = /^[A-Za-z0-9_./:=@%+-]+$/;
// `word` as one shell word: bare when it is only safe characters (and not a leading `-`, an option, or `=`,
// which zsh expands), else single-quoted.
const quote = (word) =>
  SAFE_WORD.test(word) && !/^[-=]/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

// The land command as this call ran it, every argument one shell word, so the line can be run as it stands.
function landCommand({ id, opts }) {
  const message = opts?.["--message"];
  if (message === undefined) return landNext(id);
  const flag = (name) => (opts[name] === undefined ? [] : [name, quote(opts[name])]);
  return [
    "lane",
    "merge",
    quote(id),
    ...flag("--branch"),
    "--message",
    quote(message),
    ...flag("--summary"),
  ].join(" ");
}

/** The row for a stop that keeps the ledger's set-aside files (nothing put them back yet): which they
 *  are and the command that does, so a hold is never silent. Null when the ledger holds none. */
export function heldRow(lane) {
  const held = [ALLOW, WRITES].flatMap((kind) => {
    const record = lane.ledger.merge?.[kind.key];
    return record && !isOld(record) ? record.files : []; // an old record is never restored by this command
  });
  if (held.length === 0) return null;
  const command = landCommand(lane) + (hasOldRecord(lane.ledger.merge) ? DROP_CARRY : "");
  const shown = held.slice(0, 5).join(", ") + (held.length > 5 ? `, +${held.length - 5}` : "");
  // A record that is a bug stops every put-back, so no command restores these until it is reported.
  const stuck = [ALLOW, WRITES].some((kind) => {
    const record = lane.ledger.merge?.[kind.key];
    return record && !isOld(record) && bothKinds(record);
  });
  const how = stuck ? `not restored: ${BUG_NEXT}` : `restored by ${command}`;
  return warn("allow", "files set aside by this land are still in the ledger", [
    `allow: ${held.length} file(s) set aside (${shown}) → ${how}`,
  ]);
}
