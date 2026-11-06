// Evidence rules: what a finished item must show (commits, handoff, verdict, sign-off). Pure; git is
// reached only through ctx.hasCommit. What a handoff line is (`handoffLines`, `namesCommits`) is exported:
// `board fix` (drift.mjs) counts a task's handoff by the same definition this rule checks.
import { isShaAnyCase } from "../markdown.mjs";
import { CLOSED } from "../phases.mjs";
import {
  EXCEPT,
  finding,
  kindParam,
  kindSpec,
  leadTokens,
  param,
  parentOf,
  scope,
  show,
  withId,
} from "./structure.mjs";

/** The commits a commits/evidence cell holds (as the board read it: tokens, or a string), as the rules
 *  read them. */
export const commitsIn = (value) => evidenceOf(value).shas;

// A commits/evidence cell, as an array of tokens or a string, split into commits and the rest.
function evidenceOf(value) {
  const tokens = (Array.isArray(value) ? value : String(value ?? "").split(/\s+/)).filter(Boolean);
  return {
    shas: tokens.filter(isShaAnyCase),
    note: tokens.filter((t) => !isShaAnyCase(t)).join(" "),
  };
}

const doneItems = (model, params) => scope(model, params).filter((item) => item.phase === "done");

const doneHasEvidence = {
  id: "done-has-evidence",
  params: {
    kind: kindParam("done"),
    field: { type: "field", is: "commits", required: true },
    evidence: { type: "enum", values: ["commit", "commit-or-note"], required: true },
    except: EXCEPT,
  },
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
  const named = [...line.matchAll(/\(([0-9a-f]{7,64})/gi)].map((m) => m[1].toLowerCase());
  const match = (a) => {
    const sha = a.toLowerCase();
    return named.some((b) => sha.startsWith(b) || b.startsWith(sha));
  };
  return mode === "first" ? match(shas[0]) : shas.some(match);
}

/** Task `id`'s handoff lines among a section's bold leads (`md.boldLeads`): those whose lead names the id
 *  as a whole token. A plain line, or another task's line that mentions the id, is not one. */
export const handoffLines = (leads, id) => leads.filter((l) => leadTokens(l.lead).includes(id));

/** Does one of a task's handoff `lines` name its commits `shas` the way `mode` asks (`first`: the first
 *  one, `any`: any)? Nothing is asked for `none` or a task with no commits. */
export const namesCommits = (lines, shas, mode) =>
  mode === "none" || shas.length === 0 || lines.some((l) => names(l.text ?? l.lead, shas, mode));

const doneHasHandoff = {
  id: "done-has-handoff",
  params: {
    kind: kindParam("done", "parent"),
    section: { type: "section", of: "parent", as: "bold-lead", required: true },
    commit: { type: "enum", values: ["first", "any", "none"], default: "none" },
    field: { type: "field", is: "commits", pick: true, only: { commit: ["first", "any"] } },
    except: EXCEPT,
  },
  check(model, params) {
    const section = param(params, "section");
    const mode = params.commit;
    const field = mode === "none" ? undefined : param(params, "field");
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
      const mine = handoffLines(parent.own.sections[section]?.leads ?? [], item.id);
      const where = parent.own.path;
      if (mine.length === 0) {
        out.push(finding("done-has-handoff", item, `no handoff line in ${where}`));
        continue;
      }
      if (!namesCommits(mine, field ? commitsIn(item.fields[field]) : [], mode)) {
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
  params: {
    kind: kindParam("done"),
    flag: { type: "field", is: "flag", required: true },
    verdict: { type: "field", is: "text", required: true },
    pass: { type: "strings", required: true },
    except: EXCEPT,
  },
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
  params: { kind: kindParam("done", "status-field", "children"), except: EXCEPT },
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
  params: {
    kind: kindParam("done"),
    field: { type: "field", is: "date", required: true },
    except: EXCEPT,
  },
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
