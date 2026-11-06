// stale-status — a status file kept by hand (`status.file`, its `status.next` heading) that still lists a
// task the board has finished. One nudge for the whole file, naming the ids. Read only; nothing is edited.
// The session note (`.agentry/NOTE.md`) is stale the same way once every id it names is done or answered.
// What the Now was when a note was written is kept in `<main root>/.agentry/run/note-seen.json`
// (`{ mtime, now: [ids] }`), written by `lane session start` the first time it reads a note whose mtime the
// record does not hold.
//
//   staleStatus({ root, spec, model }) -> nudge | null
//   staleNote(model, lines) -> string[] | null     the ids a note names, when all are finished
//   readNoteSeen(runRoot) -> { mtime, now } | null  null: no record, or one it cannot read
//   markNoteSeen(runRoot, note)                     record `{ mtime: note.writtenAt, now: note.now }`
//                                                   unless the record already holds that mtime
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite } from "../fs/atomic.mjs";
import * as md from "./markdown.mjs";
import { readInside } from "./read.mjs";
import { withId } from "./rules/structure.mjs";

const SHOWN = 3;

export function staleStatus({ root, spec, model }) {
  const { file, next } = spec.status ?? {};
  if (!file || !next) return null;
  const text = readInside(root, join(root, file));
  const sec = text === null ? null : md.section(text, next);
  if (!sec) return null;
  const body = text.split("\n").slice(sec.line, sec.end).join("\n");
  const done = [...new Set(body.split(/[^\w.-]+/))].filter(
    (t) => Object.hasOwn(model.index, t) && withId(model, t).some((i) => i.phase === "done"),
  );
  if (!done.length) return null;
  const more = done.length > SHOWN ? ` +${done.length - SHOWN} more` : "";
  return {
    kind: "stale-status",
    path: file,
    command: `edit ${file}: ${done.slice(0, SHOWN).join(", ")}${more} done on the board`,
  };
}

/** The ids the note `lines` name (digit-only tokens and items with no status left out) when there is at least one and every one is done (a question answered is
 *  a done phase too); null when it names none, or any is still open. An id on several kinds counts as done
 *  only when each of its items is. */
export function staleNote(model, lines) {
  const tokens = lines
    .join("\n")
    .split(/[^\w.-]+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""));
  // A bare number in prose (`step 2`) is no id, as in a brief; a decision `2` is named `D2`.
  // An item with no status (a decision) is neither open nor finished, so it names nothing here.
  const phased = (t) => withId(model, t).filter((i) => i.phase);
  const named = [...new Set(tokens)].filter(
    (t) => /[A-Za-z]/.test(t) && Object.hasOwn(model.index, t) && phased(t).length,
  );
  return named.length && named.every((t) => phased(t).every((i) => i.phase === "done"))
    ? named
    : null;
}

const seenFile = (runRoot) => join(runRoot, ".agentry", "run", "note-seen.json");

/** The Now recorded for a note: `{ mtime (ISO), now: ids }`. A missing, unreadable or malformed record is
 *  nothing seen (null), so the next start writes it again. */
export function readNoteSeen(runRoot) {
  try {
    const seen = JSON.parse(readFileSync(seenFile(runRoot), "utf8"));
    const ids = Array.isArray(seen?.now) && seen.now.every((id) => typeof id === "string");
    return typeof seen?.mtime === "string" && ids ? { mtime: seen.mtime, now: seen.now } : null;
  } catch {
    return null;
  }
}

/** Record the Now of a note read for the first time at its mtime (atomically). A record already holding
 *  this mtime is kept, so the Now stays the one the note was written under. One it cannot write is left:
 *  the next start tries again. */
export function markNoteSeen(runRoot, note) {
  if (readNoteSeen(runRoot)?.mtime === note.writtenAt) return;
  const file = seenFile(runRoot);
  try {
    mkdirSync(dirname(file), { recursive: true });
    atomicWrite(file, `${JSON.stringify({ mtime: note.writtenAt, now: note.now })}\n`);
  } catch {
    // A run folder it cannot write: the note reads as first seen again, never as stale by sprint.
  }
}
