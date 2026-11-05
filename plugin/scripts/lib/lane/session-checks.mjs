// session-checks — the repo session skills' outcomes (A42): `<main root>/.agentry/run/process/session-checks.jsonl`,
// one JSON object per line, append-only, never committed:
//   { "phase": "start" | "close", "skill", "result": "pass" | "fail", "note"?, "at": <ISO> }
// Written by `lane session <start|close> --check`; read by `lane session` and the commands.
//
// The record never claims to know a session, it reads phases. A phase's current entries are those after
// the newest entry of the other phase (all of them when there is none), and per skill the newest current
// entry counts. "Newest" is the later line in the file, never a sort by `at`: so at `/agentry:start`,
// before any start check is recorded, the close window is the last session's close.
//
// read(runRoot) -> entry[]              a line that is not an entry is skipped; their count is `.skipped`
//                                       a file it cannot use throws an Error with `.unusable` set
// record(runRoot, entry)                append one line (a torn last line first gets its line break)
// checksView(spec, entries, root) -> { start: View, close: View } | null     null: neither phase names a check
//   View = { named, recorded: [{ skill, result, note?, at }], pending, failed, missing }
//
// Beside it, the idle lanes `lane session start` asked the owner to park (field 88):
// `<main root>/.agentry/run/idle-asked.json`, `{ <id>: { lastChange, asked: <ISO> } }`, written whole
// (atomically), never committed. It holds just the lanes idle at the last start, so a lane whose lastChange
// moved, or that left idle and came back, is asked again. Unlike the checks record it never refuses: one it
// cannot read is nothing asked (and is rewritten), one it cannot write is left (the next start asks again).
//
// readIdleAsked(runRoot) -> record | {} | null                  {}: none yet; null: one it cannot read
// withAsked(record, idle) -> idle[]                             each with `asked`: the ISO when an earlier
//                                                               start asked at this lastChange, else null
// recordIdleAsked(runRoot, record, idle, { asking })            the lanes idle now: those already asked, and
//                                                               the newly idle ones when `asking` (the
//                                                               question was shown)
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite } from "../fs/atomic.mjs";
import { sessionChecks } from "../process/spec/extensions.mjs";
import { skillExists } from "../process/spec/extensions.mjs";

const PHASES = ["start", "close"];
const RESULTS = ["pass", "fail"];

const fileOf = (runRoot) => join(runRoot, ".agentry", "run", "process", "session-checks.jsonl");

const isEntry = (e) =>
  e !== null &&
  typeof e === "object" &&
  PHASES.includes(e.phase) &&
  typeof e.skill === "string" &&
  e.skill !== "" &&
  RESULTS.includes(e.result) &&
  typeof e.at === "string" &&
  (e.note === undefined || typeof e.note === "string");

// A file the record cannot use (a folder, no permission) as one error the caller says in a line: `unusable`.
const unusable = (runRoot, err) =>
  Object.assign(new Error(`cannot use ${fileOf(runRoot)}: ${err.code ?? err.message}`), {
    unusable: true,
  });

const textOf = (runRoot) => {
  try {
    return readFileSync(fileOf(runRoot), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw unusable(runRoot, err);
  }
};

/** Every entry, oldest line first. A missing file is no entries; a line that is not an entry is left out
 *  and counted in the array's `skipped`. */
export function read(runRoot) {
  const entries = [];
  let skipped = 0;
  for (const raw of textOf(runRoot).split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(raw);
      if (isEntry(entry)) entries.push(entry);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return Object.defineProperty(entries, "skipped", { value: skipped });
}

/** Append `entry` as one line; the folder is made when absent. */
export function record(runRoot, entry) {
  try {
    mkdirSync(dirname(fileOf(runRoot)), { recursive: true });
    const text = textOf(runRoot);
    const gap = text && !text.endsWith("\n") ? "\n" : "";
    appendFileSync(fileOf(runRoot), `${gap}${JSON.stringify(entry)}\n`);
  } catch (err) {
    throw err.unusable ? err : unusable(runRoot, err);
  }
}

// The entries `phase` counts now, in file order: those after the newest entry of the other phase.
function windowOf(entries, phase) {
  const other = PHASES.find((p) => p !== phase);
  return entries.slice(entries.findLastIndex((e) => e.phase === other) + 1);
}

function viewOf(spec, entries, root, phase) {
  const named = sessionChecks(spec, phase);
  const newest = new Map();
  for (const e of windowOf(entries, phase))
    if (e.phase === phase && named.includes(e.skill)) {
      newest.delete(e.skill); // the later line moves it last
      newest.set(e.skill, e);
    }
  const recorded = [...newest.values()].map(({ skill, result, note, at }) => ({
    skill,
    result,
    ...(note !== undefined && { note }),
    at,
  }));
  return {
    named,
    recorded,
    pending: named.filter((n) => !newest.has(n)),
    failed: recorded.filter((r) => r.result === "fail").map((r) => r.skill),
    missing: named.filter((n) => !skillExists(root, n)),
  };
}

/** What each phase names and what is recorded of it now; null when neither names a check. */
export function checksView(spec, entries, root) {
  if (PHASES.every((p) => sessionChecks(spec, p).length === 0)) return null;
  return {
    start: viewOf(spec, entries, root, "start"),
    close: viewOf(spec, entries, root, "close"),
  };
}

const askedFile = (runRoot) => join(runRoot, ".agentry", "run", "idle-asked.json");

/** The idle-asked record: `{}` when there is none, null when it cannot be read. */
export function readIdleAsked(runRoot) {
  try {
    const data = JSON.parse(readFileSync(askedFile(runRoot), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch (err) {
    return err.code === "ENOENT" ? {} : null;
  }
}

/** Each idle lane with `asked`: when an earlier start asked the owner to park it at this `lastChange`
 *  (ISO), or null when none did. */
export function withAsked(record, idle) {
  return idle.map((i) => {
    const was = record && Object.hasOwn(record, i.id) ? record[i.id] : null;
    const asked = was?.lastChange === i.lastChange && typeof was.asked === "string";
    return { ...i, asked: asked ? was.asked : null };
  });
}

/** Rewrite the record to the lanes idle now: each already asked, and each newly idle one (asked now)
 *  when `asking`. Left as it is when nothing changed. */
export function recordIdleAsked(runRoot, record, idle, { asking }) {
  const at = new Date().toISOString();
  const kept = idle.filter((i) => i.asked || asking);
  const after = Object.fromEntries(
    kept.map((i) => [i.id, { lastChange: i.lastChange, asked: i.asked ?? at }]),
  );
  if (record !== null && JSON.stringify(after) === JSON.stringify(record)) return;
  try {
    mkdirSync(dirname(askedFile(runRoot)), { recursive: true });
    atomicWrite(askedFile(runRoot), `${JSON.stringify(after)}\n`);
  } catch {
    // Not recorded: the next start asks again.
  }
}
