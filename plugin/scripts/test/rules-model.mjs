// Test support (not a test): hand-built Models for the rule tests. Invented ids and words only.
import { withDefaults } from "../lib/process/rules/index.mjs";

const PHASES = {
  todo: "planned",
  ready: "active",
  doing: "active",
  verify: "active",
  done: "done",
  cut: "dropped",
  later: "parked",
};
const SPRINT_PHASES = { todo: "planned", doing: "active", done: "done" };

export const SPEC = {
  version: 1,
  kinds: {
    milestone: {
      fields: { sprints: { type: "list", ref: "sprint", role: "children" } },
      status: { derived: "children" },
    },
    sprint: {
      fields: { status: {}, ok: { type: "date" } },
      status: { field: "status", values: SPRINT_PHASES },
      file: {
        glob: "sprints/{id}_*.md",
        required: true,
        except: ["PRE", "TRK", "LATER"],
        sections: {
          members: { heading: "Tasks", as: "table", column: "Task" },
          handoff: { heading: "Handoff", as: "bold-lead" },
        },
      },
    },
    task: {
      fields: {
        sprint: { type: "ref", ref: "sprint", role: "parent", also: ["EXTRA"] },
        status: {},
        deps: { type: "list", ref: ["task", "sprint", "milestone"] },
        risky: { type: "flag", mark: "!" },
        verdict: { case: "upper" },
        commit: { type: "commits" },
        note: {},
      },
      status: { field: "status", values: PHASES },
    },
    question: {
      fields: { status: {}, blocks: { type: "list", ref: "task" } },
      status: { field: "status", values: { open: "active", answered: "done" } },
    },
  },
  rules: [],
};

const parentFieldOf = (kind) =>
  Object.entries(SPEC.kinds[kind].fields).find(([, f]) => f.role === "parent")?.[0];

// items: [{ kind, id, status?, ...fields, own? }] -> Model. Phases, parents, children and rank are derived
// the way the reader would: row order of the sprint kind ranks tasks by their sprint.
export function makeModel(items, spec = SPEC) {
  const built = items.map(({ kind, id, own, phase, ...fields }, i) => {
    const table = spec.kinds[kind].status?.values;
    const parentName = parentFieldOf(kind);
    return {
      kind,
      id,
      fields,
      status: fields.status,
      phase: phase ?? (table ? table[fields.status] : undefined),
      parent: parentName ? fields[parentName] : undefined,
      children: fields.sprints ?? [],
      file: "BOARD.md",
      line: i + 1,
      own,
    };
  });
  const sprints = built.filter((i) => i.kind === "sprint");
  const rankOf = (id) => sprints.findIndex((s) => s.id === id);
  for (const item of built) {
    if (item.kind === "sprint") item.rank = rankOf(item.id);
    if (item.kind === "task" && rankOf(item.parent) >= 0) item.rank = rankOf(item.parent);
    if (item.kind === "sprint")
      item.children = built
        .filter((t) => t.kind === "task" && t.parent === item.id)
        .map((t) => t.id);
  }
  const kinds = Object.fromEntries(
    Object.keys(spec.kinds).map((k) => [
      k,
      { items: built.filter((i) => i.kind === k), located: true },
    ]),
  );
  const index = {};
  for (const item of built) index[item.id] = [...(index[item.id] ?? []), item];
  return { spec, root: "docs", kinds, index, problems: [] };
}

export const sprint = (id, status, extra = {}) => ({ kind: "sprint", id, status, ...extra });
export const task = (id, sprintId, status, extra = {}) => ({
  kind: "task",
  id,
  sprint: sprintId,
  status,
  deps: [],
  ...extra,
});
export const question = (id, status, blocks) => ({ kind: "question", id, status, blocks });

// A sprint file with the given handoff leads ({ lead, text? }) and Tasks-table rows.
export const file = (path, { rows = [], leads = [] } = {}) => ({
  path,
  sections: {
    members: { rows: rows.map((id) => ({ Task: id })) },
    handoff: { leads: leads.map((l, i) => ({ line: i + 1, ...l })) },
  },
});

export const hasAll = { hasCommit: () => true };
export const hasOnly = (...shas) => ({ hasCommit: (sha) => shas.includes(sha) });
// As `check.mjs` runs a rule: the entry with the rule's declared defaults filled in.
export const run = (rule, model, params, ctx = hasAll) =>
  rule.check(model, withDefaults(rule, { rule: rule.id, ...params }), ctx);
