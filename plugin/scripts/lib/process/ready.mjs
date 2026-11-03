// ready — `board status --ready`: the open tasks of each sprint, and for each whether its contract is
// written down and its dependencies are done. A task with both is ready to `lane exec`. Read only.
//
//   readyView({ root, spec, model })  -> [{ id, name, tasks: [{ id, status, contract, deps }] }]
//   renderReady({ name, view })       -> text, every line within WIDTH columns
import { findContract } from "./contract.mjs";
import { WIDTH, columns, fit } from "./render.mjs";
import { withId } from "./rules/structure.mjs";
import { depsOf, titleOf, workKind } from "./status.mjs";

/** Open (planned or active) tasks grouped by their parent, in board order; `contract` is whether
 *  `findContract` finds exactly one, `deps` whether every dependency is done. */
export function readyView({ root, spec, model }) {
  const work = workKind(spec);
  const deps = depsOf(spec, model, work);
  const groups = new Map();
  for (const item of model.kinds[work]?.items ?? []) {
    if (item.phase !== "planned" && item.phase !== "active") continue;
    const task = {
      id: item.id,
      status: item.status ?? item.phase,
      contract: findContract({ root, spec, id: item.id, kind: work, model }).status === "found",
      deps: deps(item).every((d) => d.phase === "done"),
    };
    groups.set(item.parent ?? "", [...(groups.get(item.parent ?? "") ?? []), task]);
  }
  return [...groups].map(([id, tasks]) => {
    const parent = withId(model, id)[0];
    return { id, name: parent ? titleOf(spec, parent) : undefined, tasks };
  });
}

const yn = (b) => (b ? "y" : "n");

/** The sprints, each with its open tasks as aligned columns; a count of the ready ones on top. */
export function renderReady({ name, view }) {
  const tasks = view.flatMap((g) => g.tasks);
  const ready = tasks.filter((t) => t.contract && t.deps).length;
  const lines = [`${name}  ${ready} of ${tasks.length} open tasks ready (contract y, deps y)`];
  for (const g of view) {
    lines.push("", fit(`${g.id || "—"}  ${g.name ?? ""}`.trimEnd(), WIDTH));
    const rows = g.tasks.map((t) => [
      t.id,
      t.status,
      `contract ${yn(t.contract)}`,
      `deps ${yn(t.deps)}`,
    ]);
    lines.push(...columns(rows).map((l) => `  ${fit(l, WIDTH - 2)}`));
  }
  return lines.join("\n");
}
