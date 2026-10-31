// Evidence rules: what a finished item must show (commits, handoff, verdict, sign-off). Pure; git is
// reached only through ctx.hasCommit.
import {
  CLOSED,
  finding,
  kindSpec,
  leadTokens,
  param,
  parentOf,
  scope,
  show,
  withId,
} from "./structure.mjs";

const SHA = /^[0-9a-f]{7,40}$/i;

// A commits/evidence cell, as an array of tokens or a string, split into commits and the rest.
function evidenceOf(value) {
  const tokens = (Array.isArray(value) ? value : String(value ?? "").split(/\s+/)).filter(Boolean);
  return {
    shas: tokens.filter((t) => SHA.test(t)),
    note: tokens.filter((t) => !SHA.test(t)).join(" "),
  };
}

// params.field, else the first commits/evidence field of the kind.
function evidenceField(model, params) {
  if (params.field) return params.field;
  const fields = Object.entries(kindSpec(model, param(params, "kind")).fields ?? {});
  const found = fields.find(([, f]) => f.type === "commits" || f.type === "evidence");
  if (!found) throw new Error("no commits or evidence field (set 'field')");
  return found[0];
}

const doneItems = (model, params) => scope(model, params).filter((item) => item.phase === "done");

const doneHasEvidence = {
  id: "done-has-evidence",
  check(model, params, ctx) {
    const field = param(params, "field");
    const mode = param(params, "evidence");
    const out = [];
    for (const item of doneItems(model, params)) {
      const { shas, note } = evidenceOf(item.fields[field]);
      if (shas.length === 0 && !(mode === "commit-or-note" && note)) {
        const wanted = mode === "commit-or-note" ? "a commit or a note" : "a commit";
        out.push(finding("done-has-evidence", item, `done without ${wanted}`));
      }
      for (const sha of shas) {
        if (!ctx.hasCommit(sha))
          out.push(finding("done-has-evidence", item, `commit ${sha} is not in git`));
      }
    }
    return out;
  },
};

// Does a handoff line name one of the task's commits? A sha matches when either is a prefix of the other.
function names(line, shas, mode) {
  const named = [...line.matchAll(/\(([0-9a-f]{7,40})/gi)].map((m) => m[1]);
  const match = (a) => named.some((b) => a.startsWith(b) || b.startsWith(a));
  return mode === "first" ? match(shas[0]) : shas.some(match);
}

const doneHasHandoff = {
  id: "done-has-handoff",
  check(model, params) {
    const section = param(params, "section");
    const mode = params.commit ?? "none";
    const field = mode === "none" ? undefined : evidenceField(model, params);
    const out = [];
    for (const item of doneItems(model, params)) {
      const parent = parentOf(model, item);
      if (!parent) continue;
      const glob = model.spec.kinds[parent.kind].file?.glob;
      if (!parent.own) {
        out.push(
          finding("done-has-handoff", item, `${parent.kind} ${parent.id} has no file (${glob})`),
        );
        continue;
      }
      const leads = parent.own.sections[section]?.leads ?? [];
      const mine = leads.filter((l) => leadTokens(l.lead).includes(item.id));
      const where = parent.own.path;
      if (mine.length === 0) {
        out.push(finding("done-has-handoff", item, `no handoff line in ${where}`));
        continue;
      }
      const { shas } = field ? evidenceOf(item.fields[field]) : { shas: [] };
      if (shas.length > 0 && !mine.some((l) => names(l.text ?? l.lead, shas, mode))) {
        out.push(
          finding("done-has-handoff", item, `handoff line in ${where} names no matching commit`),
        );
      }
    }
    return out;
  },
};

const flaggedNeedsVerdict = {
  id: "flagged-needs-verdict",
  check(model, params) {
    const flag = param(params, "flag");
    const verdict = param(params, "verdict");
    const pass = param(params, "pass").map((v) => v.toUpperCase());
    const out = [];
    for (const item of doneItems(model, params)) {
      if (!item.fields[flag] || pass.includes(String(item.fields[verdict] ?? "").toUpperCase()))
        continue;
      out.push(
        finding(
          "flagged-needs-verdict",
          item,
          `flagged and done without a ${pass.join(" or ")} verdict`,
        ),
      );
    }
    return out;
  },
};

const closedChildren = {
  id: "closed-children",
  check(model, params) {
    const out = [];
    for (const item of doneItems(model, params)) {
      const open = item.children
        .flatMap((id) =>
          withId(model, id)
            .filter((c) => c.kind !== item.kind)
            .slice(0, 1),
        )
        .filter((child) => !CLOSED.has(child.phase));
      if (open.length === 0) continue;
      out.push(
        finding("closed-children", item, `done with open ${open.map((c) => c.id).join(", ")}`),
      );
    }
    return out;
  },
};

const doneSignoff = {
  id: "done-signoff",
  check(model, params) {
    const field = param(params, "field");
    return doneItems(model, params)
      .filter((item) => !/^\d{4}-\d{2}-\d{2}/.test(String(item.fields[field] ?? "")))
      .map((item) =>
        finding("done-signoff", item, `${show(item)} without a dated sign-off in '${field}'`),
      );
  },
};

export const rules = [
  doneHasEvidence,
  doneHasHandoff,
  flaggedNeedsVerdict,
  closedChildren,
  doneSignoff,
];
