// Flow rules: what may start, in which order, and what waits on parked work. Pure.
import {
  EXCEPT,
  KIND,
  STARTED,
  finding,
  idsIn,
  kindSpec,
  param,
  parentOf,
  refKinds,
  resolve,
  scope,
  show,
} from "./structure.mjs";

// The dependency field (given, or the first that fits: `withDefaults`) and the kinds it may point at.
function depSetup(model, params) {
  const { fields } = kindSpec(model, param(params, "kind"));
  const field = param(params, "field");
  return { field, kinds: refKinds(fields[field]) };
}

// Dependencies of `item` that resolve on the board (unresolved ones are refs-resolve's business).
const depsOf = (model, item, { field, kinds }) =>
  idsIn(item.fields[field]).flatMap((id) => resolve(model, id, kinds).slice(0, 1));

const depsDone = {
  id: "deps-done",
  params: { kind: KIND, field: { type: "field", is: "deps", pick: true }, except: EXCEPT },
  check(model, params) {
    const setup = depSetup(model, params);
    const out = [];
    for (const item of scope(model, params)) {
      if (!STARTED.has(item.phase)) continue;
      for (const dep of depsOf(model, item, setup)) {
        if (dep.phase === "done") continue;
        const what = `${dep.id} (${dep.kind}, ${show(dep)})`;
        out.push(finding("deps-done", item, `${show(item)}, but depends on ${what}`));
      }
    }
    return out;
  },
};

const parentActive = {
  id: "parent-active",
  params: { kind: KIND, except: EXCEPT },
  check(model, params) {
    const out = [];
    for (const item of scope(model, params)) {
      const parent = parentOf(model, item);
      if (!parent || !parent.phase || !STARTED.has(item.phase) || STARTED.has(parent.phase))
        continue;
      out.push(
        finding(
          "parent-active",
          item,
          `${show(item)}, but ${parent.kind} ${parent.id} is ${show(parent)}`,
        ),
      );
    }
    return out;
  },
};

const sequential = {
  id: "sequential",
  params: { kind: KIND, skip: { type: "strings", default: [] }, except: EXCEPT },
  check(model, params) {
    const skip = params.skip;
    const out = [];
    let previous;
    for (const item of scope(model, params)) {
      if (skip.includes(item.id)) continue;
      if (STARTED.has(item.phase) && previous && previous.phase !== "done") {
        out.push(
          finding("sequential", item, `${show(item)}, but ${previous.id} is ${show(previous)}`),
        );
      }
      previous = item;
    }
    return out;
  },
};

const questionBlocks = {
  id: "question-blocks",
  params: {
    kind: KIND,
    field: { type: "field", is: "refs", default: "blocks" },
    except: EXCEPT,
  },
  check(model, params) {
    const field = params.field;
    const kinds = refKinds(kindSpec(model, param(params, "kind")).fields[field]);
    const blockedBy = new Map();
    for (const question of scope(model, params)) {
      if (question.phase !== "active") continue;
      for (const id of idsIn(question.fields[field])) {
        for (const blocked of resolve(model, id, kinds)) {
          blockedBy.set(blocked, [...(blockedBy.get(blocked) ?? []), question.id]);
        }
      }
    }
    return [...blockedBy]
      .filter(([blocked]) => STARTED.has(blocked.phase))
      .map(([blocked, ids]) => {
        return finding(
          "question-blocks",
          blocked,
          `${show(blocked)}, but blocked by open ${ids.join(", ")}`,
        );
      });
  },
};

const parked = {
  id: "parked",
  params: {
    kind: KIND,
    parking: { type: "string", required: true },
    field: { type: "field", is: "deps", pick: true },
    except: EXCEPT,
  },
  check(model, params) {
    const parking = param(params, "parking");
    const setup = depSetup(model, params);
    const out = [];
    for (const item of scope(model, params)) {
      if (item.parent === parking && item.phase !== "parked") {
        out.push(finding("parked", item, `sits in ${parking} but is ${show(item)}`));
      }
      if (item.phase === "parked" || item.phase === "dropped") continue;
      for (const dep of depsOf(model, item, setup)) {
        if (dep.phase !== "parked") continue;
        out.push(
          finding("parked", item, `${show(item)}, but depends on ${dep.id}, which is ${show(dep)}`),
        );
      }
    }
    return out;
  },
};

const depsNotForward = {
  id: "deps-not-forward",
  params: {
    kind: KIND,
    field: { type: "field", is: "deps", pick: true },
    skip: { type: "strings", default: [] },
    except: EXCEPT,
  },
  check(model, params) {
    const setup = depSetup(model, params);
    const skip = params.skip;
    const ordered = (item) =>
      item.rank !== undefined && !skip.includes(item.id) && !skip.includes(item.parent);
    const out = [];
    for (const item of scope(model, params)) {
      if (!ordered(item)) continue;
      for (const dep of depsOf(model, item, setup)) {
        if (!ordered(dep) || dep.rank <= item.rank) continue;
        out.push(
          finding("deps-not-forward", item, `depends on ${dep.id}, which comes later in the order`),
        );
      }
    }
    return out;
  },
};

export const rules = [depsDone, parentActive, sequential, questionBlocks, parked, depsNotForward];
