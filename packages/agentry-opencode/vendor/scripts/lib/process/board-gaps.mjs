// board-gaps — what the board lacks of a merged event for a task whose work is on main: the status, the
// commit cell and the handoff line the lifecycle would write (`lacking`), and the fix `board fix` may
// apply, or why it only reports one (`plan`). Reads the board's files; asks git nothing (the caller says
// where the work stands).
//
//   lacking({ root, spec, model, item })        -> what is missing, or null when the board has it all
//   plan({ root, spec, model, item, landed })   -> { fixes? , left? }   `landed()`: { shas } | { unsure }
import { join } from "node:path";
import * as md from "./markdown.mjs";
import { readInside } from "./read.mjs";
import { commitsIn, handoffLines, namesCommits } from "./rules/evidence.mjs";
import { parentOf } from "./rules/structure.mjs";
import { own } from "./spec/shape.mjs";
import { lifecycleOf } from "./spec/workflow.mjs";

// A field's text as written in the item's row (or frontmatter), or null when it cannot be read.
function written(root, spec, item, name) {
  const kind = spec.kinds[item.kind];
  const column = kind.fields[name]?.column;
  const text = readInside(root, join(root, spec.root, item.file));
  if (text === null || !column) return null;
  if (kind.at.table === undefined) return String(own(md.frontmatter(text)?.data, column) ?? "");
  const sec = md.section(text, kind.at.heading);
  const row = sec && md.tableIn(text, sec)?.rows.find((r) => r.line === item.line);
  return row ? md.plain(row.cells[column] ?? "") : null;
}

// The task's handoff lines in its parent's section (`handoffLines`: the bold leads naming it, the lines
// `done-has-handoff` reads) and the process file's `done-has-handoff` rules on that section. null when
// there is no such section to write to (the lifecycle refuses then).
function handoffOf(root, spec, model, item, target) {
  const section = target.slice("parent.file:".length);
  const parent = parentOf(model, item);
  const heading = parent?.own && own(spec.kinds[parent.kind].file?.sections, section)?.heading;
  const text = heading ? readInside(root, join(root, spec.root, parent.own.path)) : null;
  const sec = text === null ? null : md.section(text, heading);
  if (!sec) return null;
  const rules = spec.rules.filter(
    (r) => r.rule === "done-has-handoff" && r.kind === item.kind && r.section === section,
  );
  return { lines: handoffLines(md.boldLeads(text, sec), item.id), rules };
}

// Is the handoff there as `board check` will judge it: a line naming the task, which names its commit
// wherever a rule asks? `shasOf(rule)`: the commits that rule will read in the task's row.
const handedOff = ({ lines, rules }, shasOf) =>
  lines.length > 0 && rules.every((r) => namesCommits(lines, shasOf(r), r.commit ?? "none"));

// What the board lacks of the lifecycle's merged event for `item`: `need` (status, commit) and the
// hand-written state that stops a write: `status` (a status the lifecycle never sets before a merge) and
// `cell` (a commit cell that already holds text); `handoff` (see `handoffOf`) when the lifecycle writes one.
function gaps({ root, spec, model, item }) {
  const life = lifecycleOf(spec, item.kind) ?? spec.lifecycle; // the item's own kind's mapping
  const write = life.write ?? {};
  const need = [];
  const found = {};
  const merged = own(life.on, "merged");
  if (typeof own(write, "status") === "string" && typeof merged === "string") {
    const before = ["dispatched", "built", "failed"].map((e) => own(life.on, e));
    if (before.includes(item.status)) need.push("status");
    else if (item.status !== merged) found.status = item.status;
  }
  const field = own(write, "commit");
  if (typeof field === "string") {
    const cell = written(root, spec, item, field);
    if (cell === null) found.cell = "";
    else if (!cell.trim()) need.push("commit");
    else found.cell = cell.trim();
  }
  const target = own(write, "handoff");
  const handoff = typeof target === "string" ? handoffOf(root, spec, model, item, target) : null;
  return { need, field, handoff, ...found };
}

// What the board lacks of `item`'s merged event (`gaps`), or null when it has it all.
export function lacking({ root, spec, model, item }) {
  const found = gaps({ root, spec, model, item });
  const { need, field, status, handoff } = found;
  const asWritten = (r) => commitsIn(item.fields[r.field ?? field]);
  const whole = !need.length && status === undefined && (!handoff || handedOff(handoff, asWritten));
  return whole ? null : found;
}

// One task whose work stands as `landed()` on main (`{ shas }` or `{ unsure }`, asked only when the board
// lacks something): the merged event `board fix` would apply (only the missing steps), or why it is only
// reported. Nothing when the board has it all.
export function plan({ root, spec, model, item, landed }) {
  const lacks = lacking({ root, spec, model, item });
  if (!lacks) return {};
  const { need, field, status, cell, handoff } = lacks;
  const asWritten = (r) => commitsIn(item.fields[r.field ?? field]);
  const work = landed();
  if (work.unsure) return { left: `${item.id}: ${work.unsure}` };
  const short = work.shas[0].slice(0, 7);
  if (status !== undefined)
    return {
      left: `${item.id}: on main (${short}), but status "${status}" is set by hand; left alone`,
    };
  let shas = work.shas;
  if (cell !== undefined) {
    // A hand-written cell is never rewritten; the handoff then names the cell's first commit.
    const named = (cell.match(md.SHA_TOKEN_I) ?? []).map((t) =>
      work.shas.find((s) => s.startsWith(t.toLowerCase())),
    );
    if (!named.length || !named.every(Boolean))
      return {
        left: `${item.id}: ${field} cell "${cell}" is not the landed ${short}; left alone`,
      };
    shas = named;
  }
  // Once fix writes the commit cell, a rule reading that field reads the landed commits.
  const after = (r) => (cell === undefined && (r.field ?? field) === field ? shas : asWritten(r));
  const steps = handoff && !handedOff(handoff, after) ? [...need, "handoff"] : need;
  return steps.length ? { fixes: { id: item.id, shas, need: steps } } : {};
}
