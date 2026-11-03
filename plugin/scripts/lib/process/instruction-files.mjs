// instruction-files — where the Agentry block comes from and how a repo's instruction file is read for
// it: the process skill's `templates/agents-block.md`, and `AGENTS.md` / `CLAUDE.md` read only while
// they stay inside the repository. Shared by `board instructions` (which writes) and `board explain`'s
// lanes (which only report).
//
// TEMPLATE                                  the block's template file
// readFile(root, name) -> { text } | { text: null } | { error }
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_ROOT } from "./default-agent.mjs";
import { staysInside } from "./read.mjs";

export const TEMPLATE = join(PLUGIN_ROOT, "skills", "process", "templates", "agents-block.md");

/** The file's text, null when absent, or the reason it can't be used. */
export function readFile(root, name) {
  const file = join(root, name);
  if (!staysInside(root, file)) return { error: `${name} is a symlink out of the repository` };
  // A write would follow a broken symlink to wherever it points.
  if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() && !existsSync(file))
    return { error: `${name} is a broken symlink` };
  if (!existsSync(file)) return { text: null };
  try {
    return { text: readFileSync(file, "utf8") };
  } catch (e) {
    return { error: `cannot read ${name} (${e.code ?? e.message})` };
  }
}
