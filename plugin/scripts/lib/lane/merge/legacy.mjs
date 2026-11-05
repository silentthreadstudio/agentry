// merge/legacy — set-aside records an older version wrote, which ledgers in the field still hold: a
// carry recorded before its cells were (dev.4), and a `merge.allow` / `merge.writes` record kept as a text
// patch, from before patches were kept as bytes. Neither is ever applied: the old patch is kept in the
// run directory and the land stops until the owner restores it by hand and passes `--drop-carry`.
import { existsSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { runDir } from "../../process/ledger.mjs";
import { ok, red, setMerge } from "./lane.mjs";

// A carry with no cells was recorded before cells were (dev.4): not tampered with, just old.
export const isOldCarry = (carry) => carry.cells === undefined;
export const OLD_CARRY_LINE =
  "recorded by an older version; rerun with --drop-carry (the patch is kept)";

// A record without `enc: "bytes"` was written before the patch was kept as bytes (a text patch): it is
// never applied, whatever it holds.
export const isOld = (held) => held.enc !== "bytes";
export const OLD_LINE = "recorded by an older version (text patch); land again to restore it";

// The bytes of an old record's patch. Before the byte fix the patch was UTF-8-decoded text; after it, a
// latin1 string. A string with a character above U+00FF, or with none in U+0080–U+00FF, can only be the
// UTF-8 text. One with only U+0080–U+00FF characters could be either, so both are kept: `utf8`, and
// `latin1` (null when the text is not ambiguous).
function oldPatchBytes(patch) {
  const text = String(patch ?? "");
  const wide = [...text].some((ch) => ch.codePointAt(0) > 0xff);
  const ambiguous = !wide && /[\u0080-\u00ff]/.test(text);
  return {
    utf8: Buffer.from(text, "utf8"),
    latin1: ambiguous ? Buffer.from(text, "latin1") : null,
  };
}

// The file a record names for its kept patch, only when it is inside the lane's run dir (a ledger is
// data: a path out of it is never read or written).
function keptFile(dir, name) {
  if (typeof name !== "string" || name === "") return null;
  const file = resolve(dir, name);
  const rel = relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? file : null;
}

// An old record's patch kept once in the run dir (`patchFile` in the record: a rerun names the same file),
// then a red row that stops the land, or on `--drop-carry` an ok row and the record let go.
export function oldRecord(lane, kind, held) {
  const dir = runDir(lane.root, lane.id);
  let file = keptFile(dir, held.patchFile);
  if (!file) {
    let n = 1;
    while (existsSync(join(dir, `${kind.patch}-${n}.patch`))) n++;
    file = join(dir, `${kind.patch}-${n}.patch`);
  }
  const bytes = oldPatchBytes(held.patch);
  if (!existsSync(file)) writeFileSync(file, bytes.utf8);
  const other = bytes.latin1 && `${file}.latin1`;
  if (other && !existsSync(other)) writeFileSync(other, bytes.latin1);
  const kept = other ? `${file} (UTF-8) and ${other} (latin1 bytes)` : file;
  if (lane.opts?.["--drop-carry"]) {
    setMerge(lane, { [kind.key]: undefined });
    return ok(
      "carry",
      `dropped ${kind.edits} recorded by an older version (the owner's --drop-carry)`,
      [
        `${held.files.join(", ")}: the patch is kept in ${kept} (git apply it by hand if it matters)`,
      ],
    );
  }
  if (held.patchFile !== file) setMerge(lane, { [kind.key]: { ...held, patchFile: file } });
  return red(
    "carry",
    `recorded by an older version (text patch) → restore it by hand from ${other ? `${file} or ${other} (the text could be either: git apply the one that fits)` : file}, then rerun with --drop-carry`,
  );
}
