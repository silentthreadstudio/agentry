// status — the checked board and its derived view (plan F13 §3.5), built fresh every call from the
// Model, the rule findings, git and the optional note file. Nothing is written to the repo and nothing is
// cached here (git.mjs keeps its per-process answers); listing the ledgers sweeps the temp files of dead
// writers.
//
//   boardReport({ root, spec, model })          -> BoardReport (core's `--json` shape, without status)
//   statusView({ root, spec, model })           -> StatusView
//   noteView({ root, spec, model, runRoot })    -> the view's `note`, or undefined with no note file
//   workKind, titleOf, stateOf, depsOf          the board's work kind, an item's title, its state, its deps
// The "work" kind is the lifecycle's (else the leaf of the parent tree, ties by name); "now" is
// `status.now` (else that parent's kind). `nudges` are the work done outside Agentry's commands (`drift.mjs`)
// and `drafts` the count of the owner's calls not yet written down (`drafts.mjs`); both read `runRoot`, the
// main checkout, and add nothing to a repo with neither. Each kind exec runs beside the lifecycle
// (`exec.kinds`: debt) is counted on its own in `side`, and nowhere else. The note's `now` is read from
// `note-seen.json` (`stale-status.mjs`), which only `lane session start` writes.
import { statSync } from "node:fs";
import { join } from "node:path";
import { check } from "./check.mjs";
import { findContract } from "./contract.mjs";
import * as drafts from "./drafts.mjs";
import { keptTrees, nudges } from "./drift.mjs";
import * as git from "./git.mjs";
import { isShaAnyCase } from "./markdown.mjs";
import { readInside } from "./read.mjs";
import { refKinds, resolve } from "./rules/structure.mjs";
import { own } from "./spec/shape.mjs";
import { readNoteSeen, staleNote } from "./stale-status.mjs";

const parentField = (kind) =>
  Object.entries(kind?.fields ?? {}).find(([, f]) => f.role === "parent");

/** The kind the work happens in (tasks): the lifecycle's, else the leaf of the parent tree (a kind with a
 *  parent field that no other kind's parent field refs and that holds no children list), else any kind
 *  with a parent field. Ties go by
 *  kind name, so the order kinds are declared in never changes the answer. */
export function workKind(spec) {
  if (spec.lifecycle?.kind) return spec.lifecycle.kind;
  const kinds = Object.keys(spec.kinds).sort();
  const withParent = kinds.filter((k) => parentField(spec.kinds[k]));
  const parents = new Set(
    withParent.flatMap((k) => {
      const ref = parentField(spec.kinds[k])[1].ref;
      return Array.isArray(ref) ? ref : [ref];
    }),
  );
  // A kind that holds a children list sits above the kinds it lists, so it is never the leaf.
  const holdsChildren = (k) =>
    Object.values(spec.kinds[k]?.fields ?? {}).some((f) => f.role === "children");
  return (
    withParent.find((k) => !parents.has(k) && !holdsChildren(k)) ??
    withParent.find((k) => !parents.has(k)) ??
    withParent[0] ??
    kinds[0]
  );
}

/** An item's title: its first plain-text or link field with a value (a name, a "what", a question). */
export function titleOf(spec, item) {
  const kind = spec.kinds[item.kind];
  const fields = Object.entries(kind?.fields ?? {}).filter(
    ([n, f]) =>
      (!f.type || f.type === "text" || f.type === "link") && !f.role && n !== kind.status?.field,
  );
  const found = fields.map(([n]) => item.fields[n]).find((v) => typeof v === "string" && v);
  return found ?? undefined;
}

// Every SHA-looking token in a commits or evidence field: what the evidence rules may ask git about.
function shasOf(spec, model) {
  return Object.entries(model.kinds).flatMap(([name, { items }]) => {
    const fields = Object.entries(spec.kinds[name]?.fields ?? {})
      .filter(([, f]) => f.type === "commits" || f.type === "evidence")
      .map(([f]) => f);
    return items.flatMap((item) =>
      fields
        .flatMap((f) => [item.fields[f] ?? []].flat())
        .filter(isShaAnyCase)
        .map((t) => t.toLowerCase()),
    );
  });
}

/** Load-time problems plus every enabled rule's findings, and the counts the header shows. */
export function boardReport({ root, spec, model }) {
  // One git process for the whole board. git does not remember a miss, so the report keeps its own
  // answer for the SHAs it asked about: a missing commit costs no process per rule.
  const asked = new Set(shasOf(spec, model));
  const found = git.knownCommits(root, [...asked]);
  const ctx = {
    hasCommit: (token) => {
      const sha = token.toLowerCase();
      return asked.has(sha) ? found.has(sha) : git.hasCommit(root, sha);
    },
    contractOf: (kind, id) => findContract({ root, spec, id, kind, model }),
  };
  const findings = [...model.problems, ...check(model, spec.rules, ctx)];
  const items = Object.fromEntries(
    Object.entries(model.kinds).map(([k, v]) => [k, v.items.length]),
  );
  return {
    ok: findings.length === 0,
    name: spec.name,
    root: spec.root,
    rules: spec.rules.length,
    items,
    findings,
  };
}

/** A work item's place in a progress bar: its phase, with `active` split into verify and the rest. */
export function stateOf(item, verify) {
  if (item.phase !== "active") return item.phase ?? "planned";
  return item.status === verify ? "verify" : "active";
}

function tally(items, verify) {
  const t = { done: 0, verify: 0, active: 0, planned: 0, dropped: 0, parked: 0 };
  for (const item of items) t[stateOf(item, verify)] += 1;
  return t;
}

// The dependency field of the work kind: the deps-done rule's, else its first list naming that kind.
export function depsOf(spec, model, work) {
  const fields = Object.entries(spec.kinds[work].fields ?? {});
  const named = spec.rules.find((r) => r.rule === "deps-done" && r.kind === work)?.field;
  const [name, def] =
    fields.find(([n]) => n === named) ??
    fields.find(([, f]) => f.type === "list" && refKinds(f).includes(work)) ??
    [];
  if (!name) return () => [];
  return (item) =>
    [item.fields[name] ?? []].flat().flatMap((id) => resolve(model, id, refKinds(def)).slice(0, 1));
}

// Each `exec.kinds` kind, in key order: its open count (planned and active), its active items, its done.
function sideOf(spec, model) {
  return Object.keys(own(spec.exec, "kinds") ?? {}).map((kind) => {
    const items = own(model.kinds, kind)?.items ?? [];
    const count = (...phases) => items.filter((i) => phases.includes(i.phase)).length;
    return {
      kind,
      label: spec.kinds[kind]?.label ?? kind,
      open: count("planned", "active"),
      active: items
        .filter((i) => i.phase === "active")
        .map((i) => ({ id: i.id, status: i.status })),
      done: count("done"),
    };
  });
}

// The kind `now` lists: `status.now`, else the kind the work kind's parent field refs.
const nowKind = (spec) =>
  spec.status?.now ?? refKinds(parentField(spec.kinds[workKind(spec)])?.[1])[0];
const activeNow = (spec, model) =>
  (model.kinds[nowKind(spec)]?.items ?? []).filter((i) => i.phase === "active").map((i) => i.id);

const OLD_MS = 12 * 3_600_000; // a note this old or older is `old`

// The note file's text and its mtime (`writtenAt`, ISO): its age is the file's, never a clock in its text.
function readNote(root, path) {
  const file = join(root, path);
  const text = readInside(root, file);
  if (text === null) return undefined;
  let writtenAt;
  try {
    writtenAt = statSync(file).mtime.toISOString();
  } catch {
    return undefined;
  }
  return { path, lines: text.trimEnd().split("\n"), writtenAt };
}

const sameIds = (a, b) => a.length === b.length && a.every((id) => b.includes(id));

// Why the note is stale, the sprint first: the Now recorded for its mtime is not the Now active (never on
// a first read, which has nothing recorded), else every id it names is finished. Nothing when neither.
function stale(model, note, seen, active) {
  if (seen && !sameIds(seen.now, active))
    return { stale: { why: "now-changed", was: seen.now, now: active } };
  const ids = staleNote(model, note.lines);
  return ids ? { stale: { why: "ids-done", ids } } : {};
}

/** The note as the status view carries it: `{ path, lines, writtenAt, now, old, stale? }`. `now` is the
 *  ids of the Now items active when it was written (as recorded for its mtime; the active ones on a first
 *  read), `old` whether it is 12 h old or more, `stale` `{ why: "now-changed", was, now }` or
 *  `{ why: "ids-done", ids }`. Reads only. */
export function noteView({ root, spec, model, runRoot = root }) {
  const note = readNote(root, spec.status?.note ?? ".agentry/NOTE.md");
  if (!note) return undefined;
  const active = activeNow(spec, model);
  const recorded = readNoteSeen(runRoot);
  const seen = recorded?.mtime === note.writtenAt ? recorded : null;
  return {
    ...note,
    now: seen ? seen.now : active,
    old: Date.now() - Date.parse(note.writtenAt) >= OLD_MS,
    ...stale(model, note, seen, active),
  };
}

export function statusView({ root, spec, model, runRoot = root }) {
  const work = workKind(spec);
  const now = nowKind(spec);
  const verify = spec.lifecycle?.on?.built ?? "verify";
  const items = model.kinds[work]?.items ?? [];
  const nowItems = now ? (model.kinds[now]?.items ?? []) : [];
  const childrenOf = (parent) => items.filter((i) => i.parent === parent.id);
  const progress = (item) => {
    const t = tally(childrenOf(item), verify);
    const total = t.done + t.verify + t.active + t.planned + t.dropped;
    return {
      kind: item.kind,
      id: item.id,
      name: titleOf(spec, item),
      status: item.status ?? item.phase,
      done: t.done,
      total,
      tally: t,
    };
  };
  // Kinds outside the tree with a status of their own (owner questions): their open items are on you.
  const tree = new Set(
    Object.values(spec.kinds).flatMap((k) =>
      Object.values(k.fields ?? {})
        .filter((f) => f.role)
        .flatMap(refKinds),
    ),
  );
  const side = sideOf(spec, model);
  const beside = new Set(side.map((x) => x.kind));
  const loose = Object.entries(spec.kinds)
    .filter(
      ([k, def]) =>
        k !== work && !tree.has(k) && !beside.has(k) && def.status?.field && !parentField(def),
    )
    .flatMap(([k]) => model.kinds[k]?.items ?? []);
  const deps = depsOf(spec, model, work);
  const blocked = items
    .filter((i) => i.phase === "planned")
    .map((i) => ({
      id: i.id,
      by: deps(i)
        .filter((d) => d.phase !== "done")
        .map((d) => d.id),
    }))
    .filter((b) => b.by.length);
  const branch = git.defaultBranch(root) ?? "HEAD";
  const note = noteView({ root, spec, model, runRoot });
  return {
    now: nowItems.filter((i) => i.phase === "active").map(progress),
    inFlight: items
      .filter((i) => i.phase === "active")
      .map((i) => ({ id: i.id, status: i.status })),
    onYou: [
      ...items.filter((i) => stateOf(i, verify) === "verify"),
      ...loose.filter((i) => i.phase === "active"),
    ].map((i) => ({ kind: i.kind, id: i.id, status: i.status })),
    blocked,
    // A sprint holding only parked rows has nothing to count here: the parked total already has them.
    ahead: nowItems
      .filter((i) => i.phase === "planned")
      .map(progress)
      .filter((p) => p.total > 0 || !p.tally.parked),
    parked: items.filter((i) => i.phase === "parked").length,
    side,
    nudges: nudges({ root, runRoot, spec, model }),
    kept: keptTrees({ root, runRoot, spec }).map((t) => ({ path: t.path, branch: t.branch })),
    drafts: drafts.pending(runRoot).length,
    recent: git.log(root, { ref: branch, n: 10, firstParent: true }),
    ...(note ? { note } : {}),
  };
}
