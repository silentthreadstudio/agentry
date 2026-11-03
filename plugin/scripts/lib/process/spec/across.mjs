// across — every check that reads both files, the board (`process.json`) and the workflow
// (`workflow.json`), and nothing else: a workflow key that names a kind, field or rule of the board. Each
// takes the merged spec; a problem's path starts with the key it is about (`rules[i]` for the process
// file, `lifecycle.*` for the workflow file), and `spec.mjs` files it there. PURE: never reads, never throws.
//
// - lifecycle: what the writer (`lifecycle.mjs`) puts where a rule reads it (`checkLifecycle`), a handoff
//   template the enabled `done-has-handoff` rule accepts (`checkHandoff`), and a done status only
//   `merged` writes, with what the "done" rules read (`checkDone`). The first and last hold for every kind
//   exec runs: the lifecycle's (paths `lifecycle.*`) and each `exec.kinds` entry (`exec.kinds.<k>.*`),
//   whose keys name a kind with no parent field (`checkExecKinds`).
import { boldLeads } from "../markdown.mjs";
import { FIELD, ruleOf, withDefaults } from "../rules/index.mjs";
import { flagField, resolveWorkflow } from "./presets.mjs";
import { describe, fieldsOf, parentOf, refsOf, sectionsOf } from "./rules.mjs";
import { entries, has, isObject, own, quote } from "./shape.mjs";
import { SLOT, SLOTS, fillHandoff, lifecycleOf, runKinds } from "./workflow.mjs";

/** The workflow's names of the board: `lifecycle.kind` and each `drafts.*.kind` name a kind, the flag field
 *  `exec.verify` reads, and what `checkLifecycle` holds the lifecycle to. */
export function checkAcross(spec, bad) {
  const kinds = isObject(spec.kinds) ? spec.kinds : {};
  const known = (name, at) =>
    typeof name !== "string" || has(kinds, name) || bad(at, `names an unknown kind "${name}"`);
  known(spec.lifecycle?.kind, "lifecycle.kind");
  checkExecKinds(spec, kinds, bad);
  checkVerifyRoute(spec, kinds, bad);
  for (const [d, def] of entries(spec.drafts)) known(def?.kind, `drafts.${d}.kind`);
  checkLifecycle(spec, bad);
}

/** The checks that try the lifecycle on a probe board; run on otherwise valid files only. */
export function checkProbes(spec, bad) {
  checkHandoff(spec, bad);
  checkDone(spec, bad);
}

// Each `exec.kinds` key names a declared kind other than the lifecycle's, outside the tree: no parent field,
// and no other kind's parent or `children` list. `exec.kinds` (even empty) needs the lifecycle, whose
// kind runs first.
function checkExecKinds(spec, kinds, bad) {
  const map = own(own(spec, "exec"), "kinds");
  if (!isObject(map)) return;
  if (!isObject(spec.lifecycle))
    return bad("exec.kinds", "needs lifecycle: exec runs these kinds beside the lifecycle's");
  for (const name of Object.keys(map)) {
    const at = `exec.kinds.${name}`;
    const parent = has(kinds, name) && parentOf(kinds[name]);
    const children = Object.keys(kinds).filter(
      (k) => k !== name && refsOf(parentOf(kinds[k])?.[1]).includes(name),
    );
    const listers = Object.keys(kinds).filter(
      (k) =>
        k !== name &&
        Object.values(fieldsOf(kinds[k])).some(
          (f) => f?.role === "children" && refsOf(f).includes(name),
        ),
    );
    if (name === spec.lifecycle.kind) bad(at, "is the lifecycle kind already");
    else if (!has(kinds, name)) bad(at, `names an unknown kind "${name}"`);
    else if (parent)
      bad(
        at,
        `the ${name} kind has a parent field "${parent[0]}"; a kind exec runs beside the lifecycle has none`,
      );
    else if (children.length)
      bad(
        at,
        `the ${name} kind is the parent of ${children.join(" and ")}; a kind exec runs beside the lifecycle stands alone`,
      );
    else if (listers.length)
      bad(
        at,
        `the ${name} kind is listed as children of ${listers.join(" and ")}; a kind exec runs beside the lifecycle stands alone`,
      );
  }
}

// `exec.verify: "flagged"` (given, or the preset's) needs a flag field (`exec.flagField`) on every kind exec
// runs, else its items would skip verification: refused at load, naming where "flagged" came from. A
// flagField the file names must be a flag field of every kind exec runs, whatever the route.
function checkVerifyRoute(spec, kinds, bad) {
  const field = flagField(spec);
  const names = runKinds(spec);
  const lacking = (names.length ? names : ["task"]).filter(
    (name) => own(fieldsOf(own(kinds, name)), field)?.type !== "flag",
  );
  const no = (name) => `the ${name} kind has no flag field named "${field}"`;
  if (has(own(spec, "exec"), "flagField"))
    return lacking.forEach((name) => bad("exec.flagField", `is "${field}", but ${no(name)}`));
  const { preset, exec, set } = resolveWorkflow(spec);
  if (exec.verify !== "flagged") return;
  const from = set.includes("exec.verify") ? "set" : `preset ${preset}`;
  for (const name of lacking)
    bad(
      "exec.verify",
      `is "flagged" (${from}), but the ${name} kind has no field named "${field}" of type "flag"`,
    );
}

// Each runnable kind's mapping (`lifecycleOf`) with the path its problems start with.
const mappings = (spec) =>
  runKinds(spec).flatMap((name) => {
    const life = lifecycleOf(spec, name);
    const at = name === spec.lifecycle.kind ? "lifecycle" : `exec.kinds.${name}`;
    return life ? [[life, at]] : [];
  });

/** What the lifecycle writer (`lifecycle.mjs`) takes for granted: each `on` word is a status of the
 *  kind, the status goes to its status field, the verdict to a text field, the commits to a commits
 *  field, the handoff line to a bold-lead section of the parent's file, from a one-line template that
 *  fills only {id}, {sha} and {summary}. Otherwise a write would land where no rule reads it. */
export function checkLifecycle(spec, bad) {
  for (const [life, at] of mappings(spec)) checkMapping(spec, life, at, bad);
}

function checkMapping(spec, life, at, bad) {
  if (!has(spec.kinds, life.kind)) return;
  const name = life.kind;
  const kind = isObject(spec.kinds[name]) ? spec.kinds[name] : {};
  const fields = fieldsOf(kind);
  const status = isObject(kind.status) ? kind.status : {};
  const words = isObject(status.values) ? status.values : null;
  for (const [event, word] of entries(life.on))
    if (typeof word === "string" && !has(words, word))
      bad(
        `${at}.on.${event}`,
        words
          ? `"${word}" is not a ${name} status (${quote(Object.keys(words))})`
          : `names a status, but ${name} has no status field`,
      );
  const write = isObject(life.write) ? life.write : {};
  if (typeof write.status === "string" && write.status !== status.field)
    bad(
      `${at}.write.status`,
      `is "${write.status}", but ${name}'s status is read from ${typeof status.field === "string" ? `"${status.field}"` : "its children"}`,
    );
  for (const [key, is] of [
    ["verdict", "text"],
    ["commit", "commits"],
  ]) {
    const f = write[key];
    if (typeof f !== "string") continue;
    if (!has(fields, f)) bad(`${at}.write.${key}`, `names no ${name} field "${f}"`);
    else if (!FIELD[is].fits(fields[f], name))
      bad(`${at}.write.${key}`, `names ${describe(fields[f], f)}; it needs ${FIELD[is].says()}`);
  }
  if (at !== "lifecycle") return; // an exec.kinds entry writes no handoff (its shape refuses one)
  const target = typeof write.handoff === "string" && /^parent\.file:.+$/.test(write.handoff);
  if (target) {
    const section = write.handoff.slice("parent.file:".length);
    const refs = refsOf(parentOf(kind)?.[1]);
    const fits = (k) => own(sectionsOf(own(spec.kinds, k)), section)?.as === "bold-lead";
    if (refs.length === 0) bad("lifecycle.write.handoff", `needs a parent field on ${name}`);
    else if (!refs.some(fits))
      bad(
        "lifecycle.write.handoff",
        `names no bold-lead section "${section}" of the ${refs.join(" or ")} file`,
      );
    if (!has(life, "handoff"))
      bad("lifecycle.write.handoff", 'needs the line it writes: a "handoff" template');
  }
  if (typeof life.handoff !== "string") return;
  if (/[\r\n]/.test(life.handoff)) bad("lifecycle.handoff", "should be one line");
  for (const [, slot] of life.handoff.matchAll(SLOT))
    if (!SLOTS.includes(slot))
      bad(
        "lifecycle.handoff",
        `fills no {${slot}} (it fills ${SLOTS.map((s) => `{${s}}`).join(", ")})`,
      );
}

// The ids and values a handoff template is tried with (`checkHandoff`).
const PROBE = { id: "X1", parent: "P1", sha: "0a1b2c3", summary: "a summary" };

// The `done-has-handoff` entries of the process file that judge the lifecycle's kind: [index, entry].
const handoffRules = (spec) =>
  spec.rules.flatMap((entry, i) =>
    entry.rule === "done-has-handoff" && entry.kind === spec.lifecycle.kind ? [[i, entry]] : [],
  );

/** The first message of the `done-has-handoff` rules (those on the lifecycle's kind) rejecting `line`
 *  as the handoff of item `id`, whose first commit is `sha`, written under a parent `parent`; null
 *  when they all accept it. The same check the board runs, on a board of just that item, so the
 *  writer can ask it of the very line it is about to write. */
export function handoffRejection(spec, line, { id, sha, parent }) {
  const rule = ruleOf("done-has-handoff");
  for (const [i, entry] of handoffRules(spec)) {
    const params = withDefaults(rule, entry, spec.kinds);
    const model = probeBoard(spec, params, line, { id, sha, parent });
    let found;
    try {
      found = model ? rule.check(model, params, { hasCommit: () => true }) : [];
    } catch (error) {
      found = [{ message: error.message }];
    }
    if (found.length) return `rules[${i}] (done-has-handoff) rejects: ${found[0].message}`;
  }
  return null;
}

/** Only `merged` may finish a task (A23: done = on main), and when it does it must write everything the
 *  "done" rules on the lifecycle's kind read: a `done-has-evidence` field gets the commits, a
 *  `done-signoff` date is never written by the lifecycle (so that rule can't sit on its kind). Otherwise
 *  an event the writer applies would leave a done task the checker rejects. */
export function checkDone(spec, bad) {
  for (const [life, at] of mappings(spec)) doneOf(spec, life, at, bad);
}

function doneOf(spec, life, at, bad) {
  if (!has(spec.kinds, life.kind)) return;
  const values = spec.kinds[life.kind]?.status?.values;
  const phaseOf = (word) => (isObject(values) && has(values, word) ? values[word] : undefined);
  let finishes = false;
  for (const [event, word] of entries(life.on)) {
    if (phaseOf(word) !== "done") continue;
    if (event !== "merged")
      bad(`${at}.on.${event}`, `sets "${word}", a done status; only "merged" may finish a task`);
    else finishes = true;
  }
  if (!finishes) return;
  const write = isObject(life.write) ? life.write : {};
  spec.rules.forEach((entry, i) => {
    if (!isObject(entry) || entry.kind !== life.kind) return;
    if (entry.rule === "done-has-evidence" && write.commit !== entry.field)
      bad(
        `${at}.write.commit`,
        `is ${write.commit === undefined ? "missing" : JSON.stringify(write.commit)}, but rules[${i}] (done-has-evidence) reads the commits of a done ${life.kind} from "${entry.field}"`,
      );
    if (entry.rule === "done-signoff")
      bad(
        `rules[${i}]`,
        `(done-signoff) needs a dated sign-off on a done ${life.kind}, which "merged" never writes`,
      );
  });
}

/** Load-time self-consistency (plan R1b §2.6): with a `done-has-handoff` rule on the lifecycle's kind,
 *  the line the writer would append, filled with a fake SHA, goes through that rule's own check on a
 *  one-item board. A template the rule rejects (no bold lead, the SHA not right after `(` with
 *  `commit: "first"`), a handoff written to another section than the rule reads, or no handoff
 *  written at all, is a spec error: the writer can never produce a line the checker rejects. Run on
 *  otherwise valid files only. (The id and SHAs of a real event are checked again when it is applied.) */
export function checkHandoff(spec, bad) {
  const life = spec.lifecycle;
  if (!isObject(life)) return;
  const rules = handoffRules(spec);
  if (rules.length && typeof life.write?.handoff !== "string")
    return bad(
      "lifecycle.write.handoff",
      `is missing, but rules[${rules[0][0]}] (done-has-handoff) reads the ${life.kind} handoff line it would write`,
    );
  if (typeof life.handoff !== "string") return;
  const line = fillHandoff(life.handoff, PROBE);
  const section = /^parent\.file:(.+)$/.exec(life.write?.handoff ?? "")?.[1];
  for (const [i, entry] of rules)
    if (section !== undefined && section !== entry.section)
      return bad(
        "lifecycle.write.handoff",
        `writes to section "${section}", but rules[${i}] (done-has-handoff) reads "${entry.section}"`,
      );
  const found = handoffRejection(spec, line, PROBE);
  if (found) bad("lifecycle.handoff", `renders ${JSON.stringify(line)}, which ${found}`);
}

// A board of one done item (`id`, its commits field holding `sha`) and its parent, whose
// handoff section holds `line` alone. Null when no kind the parent field refs has that section.
function probeBoard(spec, params, line, { id, sha, parent: parentId }) {
  const name = spec.lifecycle.kind;
  const refs = refsOf(parentOf(spec.kinds[name])?.[1]);
  const parentKind = refs.find((k) => has(sectionsOf(own(spec.kinds, k)), params.section));
  if (!parentKind) return null;
  const item = {
    kind: name,
    id: id,
    fields: params.field ? { [params.field]: [sha] } : {},
    phase: "done",
    parent: parentId,
    children: [],
    file: "probe",
    line: 1,
  };
  const leads = boldLeads(line);
  const parent = {
    kind: parentKind,
    id: parentId,
    fields: {},
    children: [id],
    file: "probe",
    line: 1,
    own: { path: `its ${params.section} section`, sections: { [params.section]: { leads } } },
  };
  const kinds = Object.fromEntries(Object.keys(spec.kinds).map((k) => [k, { items: [] }]));
  kinds[parentKind].items.push(parent);
  kinds[name].items.push(item);
  const index = { [id]: [item], [parentId]: [parent] };
  return { spec, kinds, index, problems: [] };
}
