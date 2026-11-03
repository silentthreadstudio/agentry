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
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sessionChecks } from "../process/spec/extensions.mjs";
import { skillExists } from "./merge/rows.mjs";

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
