// frontmatter — a record file is `---`, the YAML frontmatter, `---`, a blank line, the prose body (a fact's
// text, an episode's task), a newline. This splits the text of a file into its frontmatter and body and
// puts them back together; the YAML itself is read by yaml-read.mjs and written by yaml-write.mjs. Pure.
//
// split(raw) -> { front: object, body: string }     throws Error when the file has no header or bad YAML
// join(front, body) -> string                       the file's text
import { parseMap } from "./yaml-read.mjs";
import { stringifyMap } from "./yaml-write.mjs";

// LF endings: a file that was saved with CRLF has no header. A merge conflict in the header or the YAML
// fails the read; one confined to the body loads as text.
const FILE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function split(raw) {
  const m = FILE.exec(raw);
  if (!m)
    throw new Error("no frontmatter header (the file must open with a '---' line, LF endings)");
  return { front: parseMap(m[1] ?? ""), body: (m[2] ?? "").trim() };
}

export const join = (front, body) => `---\n${stringifyMap(front)}---\n\n${body}\n`;
