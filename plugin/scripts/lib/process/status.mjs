// status — the checked board and its derived view (plan F13 §3.5), built fresh every call from the
// Model, the rule findings, git and the optional note file. Nothing is cached or written.
//
//   boardReport({ root, spec, model })          -> BoardReport (core's `--json` shape, without status)
//   statusView({ root, spec, model })           -> StatusView
// The "work" kind is the lifecycle's (else the first kind with a parent); "now" is `status.now` (else
// that parent's kind). Worktrees and decision drafts join when the ledger and drafts land (T8a/T9).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "./check.mjs";
import * as git from "./git.mjs";
import { refKinds, resolve } from "./rules/structure.mjs";

const parentField = (kind) =>
  Object.entries(kind?.fields ?? {}).find(([, f]) => f.role === "parent");

/** The kind the work happens in (tasks): the lifecycle's, else the first kind with a parent field. */
export function workKind(spec) {
  const kinds = Object.keys(spec.kinds);
  return spec.lifecycle?.kind ?? kinds.find((k) => parentField(spec.kinds[k])) ?? kinds[0];
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

const SHA = /^[0-9a-f]{7,40}$/i;

// Every SHA-looking token in a commits or evidence field: what the evidence rules may ask git about.
function shasOf(spec, model) {
  return Object.entries(model.kinds).flatMap(([name, { items }]) => {
    const fields = Object.entries(spec.kinds[name]?.fields ?? {})
      .filter(([, f]) => f.type === "commits" || f.type === "evidence")
      .map(([f]) => f);
    return items.flatMap((item) =>
      fields.flatMap((f) => [item.fields[f] ?? []].flat()).filter((t) => SHA.test(t)),
    );
  });
}

/** Load-time problems plus every enabled rule's findings, and the counts the header shows. */
export function boardReport({ root, spec, model }) {
  git.knownCommits(root, shasOf(spec, model)); // one git process for the whole board
  const ctx = { hasCommit: (sha) => git.hasCommit(root, sha) };
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
function depsOf(spec, model, work) {
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

function readNote(root, path) {
  try {
    const lines = readFileSync(join(root, path), "utf8").trimEnd().split("\n");
    return { path, lines };
  } catch {
    return undefined;
  }
}

export function statusView({ root, spec, model }) {
  const work = workKind(spec);
  const now = spec.status?.now ?? refKinds(parentField(spec.kinds[work])?.[1])[0];
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
  const loose = Object.entries(spec.kinds)
    .filter(([k, def]) => k !== work && !tree.has(k) && def.status?.field && !parentField(def))
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
  const note = readNote(root, spec.status?.note ?? ".agentry/NOTE.md");
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
    ahead: nowItems.filter((i) => i.phase === "planned").map(progress),
    parked: items.filter((i) => i.phase === "parked").length,
    recent: git.log(root, { ref: branch, n: 10, firstParent: true }),
    ...(note ? { note } : {}),
  };
}
