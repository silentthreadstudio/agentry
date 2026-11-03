// stale-status — a status file kept by hand (`status.file`, its `status.next` heading) that still lists a
// task the board has finished. One nudge for the whole file, naming the ids. Read only; nothing is edited.
//
//   staleStatus({ root, spec, model }) -> nudge | null
import { join } from "node:path";
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
