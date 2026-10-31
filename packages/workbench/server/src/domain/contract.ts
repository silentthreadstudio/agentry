// contract — the task `## Contract` block, parsed. Pure, no I/O.
//
// A task declares the files it OWNS. That single field is what makes two of Agentry's most valuable
// board signals possible, and neither is available anywhere else:
//
//   • a `blocked by` chip — a task whose `deps` are not yet done,
//   • the contract-overlap warning — two tasks running at once that own the same file, which is the
//     silent-clobber failure the planning skill exists to prevent and that nothing else in this space
//     surfaces at all.
//
// The block is YAML-SHAPED PROSE inside the markdown body, not fenced and not frontmatter (FLOW owns
// frontmatter; the planner writes the contract into the body). So this parses defensively: it reads the
// keys it understands and ignores everything else, and a task with no contract yields empty lists
// rather than throwing.

const SECTION = /^##\s+Contract\s*$/im;
const NEXT_SECTION = /^##\s+/m;

/** A task's declared contract. Absent keys are empty arrays — never undefined, so callers don't branch. */
export interface TaskContract {
  owns: string[];
  deps: string[];
}

/** Extract the `## Contract` section's text, or "" when the task has none. */
function section(body: string): string {
  const start = SECTION.exec(body);
  if (!start) return "";
  const rest = body.slice(start.index + start[0].length);
  const end = NEXT_SECTION.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}

// A yaml-ish list under `key:` — either an inline `key: [a, b]` or a block of `  - item` lines. Stops at
// the next unindented key, so `owns:` never swallows the `exposes:` that follows it.
function listOf(text: string, key: string): string[] {
  const inline = new RegExp(`^${key}:\\s*\\[(.*?)\\]\\s*$`, "im").exec(text);
  if (inline) {
    return inline[1]!
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }

  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${key}:\\s*$`, "i").test(l.trim()));
  if (start === -1) return [];

  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item) {
      items.push(
        item[1]!
          .trim()
          .replace(/^["']|["']$/g, "")
          .replace(/^`|`$/g, ""),
      );
      continue;
    }
    if (line.trim().length === 0) continue; // a blank line inside a list is not the end of it
    break; // an unindented line ends the list
  }
  return items;
}

/** Parse a task body's contract. `deps` also comes from here because the planner writes it in the
 *  contract block as often as in frontmatter — the caller merges both sources. */
export function parseContract(body: string): TaskContract {
  const text = section(body);
  if (text.length === 0) return { owns: [], deps: [] };
  return { owns: listOf(text, "owns"), deps: listOf(text, "deps") };
}

/** The files two contracts both claim. Empty when they are disjoint — which is the parallel-safe case
 *  the planner is supposed to guarantee, and this is how we check it actually did. */
export function sharedFiles(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(a.map((p) => p.trim()).filter(Boolean));
  return [...new Set(b.map((p) => p.trim()).filter((p) => p.length > 0 && set.has(p)))];
}
