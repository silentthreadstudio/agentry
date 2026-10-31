// board explain [--json] — how the process file meets the board (plan F13 §2.4), the ground truth
// `/agentry:init` learns against: per kind, where it was found, its items, table columns no field
// maps, unknown status values, unresolved refs and read problems; per catalog rule, on or off and its
// finding count. Writes nothing; exit 0.
//
// run(argv, { root, spec, model }) -> { exit, out }
import { join } from "node:path";
import { check } from "../check.mjs";
import * as md from "../markdown.mjs";
import { readInside } from "../read.mjs";
import { columns } from "../render.mjs";
import { CATALOG } from "../rules/index.mjs";
import { boardReport } from "../status.mjs";

const WIDTH = 100;

// A table kind's header names that neither the id nor any field reads.
function unmapped(root, spec, kind) {
  if (!kind.at.table) return [];
  const text = readInside(root, join(root, spec.root, kind.at.table));
  if (text === null) return [];
  const sec = md.section(text, kind.at.heading);
  const table = sec && md.tableIn(text, sec);
  const used = new Set([kind.id?.column, ...Object.values(kind.fields ?? {}).map((f) => f.column)]);
  return (table?.header ?? []).filter((h) => !used.has(h));
}

export function explain({ root, spec, model }) {
  const report = boardReport({ root, spec, model });
  const basics = check(model, [{ rule: "status-known" }, { rule: "refs-resolve" }], {});
  const kinds = Object.entries(spec.kinds).map(([name, kind]) => {
    const { items, located } = model.kinds[name];
    const of = (rule) => basics.filter((f) => f.rule === rule && f.kind === name);
    const unknown = {};
    for (const f of of("status-known")) {
      const item = items.find((i) => i.id === f.id && i.kind === name);
      unknown[item?.status ?? ""] = (unknown[item?.status ?? ""] ?? 0) + 1;
    }
    const at = kind.at.table ? `${kind.at.table} › ${kind.at.heading}` : kind.at.files;
    return {
      kind: name,
      at,
      located,
      items: items.length,
      ...(kind.file ? { files: items.filter((i) => i.own).length } : {}),
      unmapped: unmapped(root, spec, kind),
      unknownStatus: unknown,
      unresolved: of("refs-resolve").map((f) => `${f.id}: ${f.message}`),
      problems: model.problems.filter((p) => p.kind === name).map((p) => p.message),
    };
  });
  const listed = spec.rules.map((e) => ({
    rule: e.rule,
    ...(e.label ? { label: e.label } : {}),
    ...(e.kind ? { kind: e.kind } : {}),
    on: true,
    findings: report.findings.filter((f) => f.rule === e.rule && f.label === e.label).length,
  }));
  const off = Object.keys(CATALOG)
    .filter((id) => !spec.rules.some((e) => e.rule === id))
    .map((rule) => ({ rule, on: false }));
  return { name: spec.name, root: spec.root, kinds, rules: [...listed, ...off] };
}

function render(data) {
  const on = data.rules.filter((r) => r.on).length;
  const head = `${data.name} · ${data.root} · ${data.kinds.length} kinds · ${on} rules on`;
  const kindRows = data.kinds.map((k) => [
    k.kind,
    k.at,
    k.located ? `${k.items} items` : "not found",
    k.files === undefined ? "" : `${k.files} with a file`,
  ]);
  const notes = data.kinds.flatMap((k) => [
    ...(k.unmapped.length ? [`${k.kind}: columns no field reads: ${k.unmapped.join(", ")}`] : []),
    ...Object.entries(k.unknownStatus).map(([v, n]) => `${k.kind}: unknown status "${v}" (${n})`),
    ...k.unresolved.map((u) => `${k.kind}: unresolved ${u}`),
    ...k.problems.map((p) => `${k.kind}: ${p}`),
  ]);
  const ruleRows = data.rules.map((r) => [
    r.on ? "on" : "off",
    r.label ? `${r.label} ${r.rule}` : r.rule,
    r.kind ?? "",
    r.on ? `${r.findings} finding${r.findings === 1 ? "" : "s"}` : "",
  ]);
  return [
    head,
    "",
    ...columns([["kind", "where", "found", "own files"], ...kindRows], WIDTH),
    ...notes.map((n) => `  ${n}`.slice(0, WIDTH)),
    "",
    ...columns([["", "rule", "kind", "findings"], ...ruleRows], WIDTH),
  ].join("\n");
}

export function run(argv, ctx) {
  const data = explain(ctx);
  return { exit: 0, out: argv.includes("--json") ? JSON.stringify(data) : render(data) };
}
