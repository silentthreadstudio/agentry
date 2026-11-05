// decisions — the board's decisions a brief quotes: the decision kind, the rows a contract cites by id
// or that name the task, and the cited ids the board does not have. Reads the board's files inside the
// repository; writes nothing.
//
//   decisionKind    the kind `drafts.decision` names, else a kind called "decision"
//   citedDecisions  every decision the block cites by id, the rows that name the task (decided after the
//                   contract was written) and those the owner asked for with `--cite`, each row quoted
//   unknownCites    the `--cite` ids that name no decision on the board
import { join } from "node:path";
import { readInside } from "../process/read.mjs";
import { own } from "../process/spec/shape.mjs";

/** The board's decision kind: the one `drafts.decision` names, else a kind called "decision". */
export function decisionKind(spec) {
  const named = own(own(spec?.drafts, "decision"), "kind");
  if (typeof named === "string" && own(spec?.kinds, named)) return named;
  return own(spec?.kinds, "decision") ? "decision" : null;
}

const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const mentions = (text, id) =>
  new RegExp(`(?<![A-Za-z0-9_-])${literal(id)}(?![A-Za-z0-9_])`).test(text);

/** Every decision to quote, as `{ id, text }`: `id` as the board writes it (the kind's display `prefix` +
 *  its id, `D12`), `text` its table row quoted from the file (or its fields for a one-file-per-item
 *  kind). A decision is in when the block cites it by id, when its row names the task `task` (a decision
 *  made after the contract was written), or when its id is in `cite` (any case). An id made of digits
 *  only is never matched in prose. */
export function citedDecisions({ root, spec, model, block, task, cite = [] }) {
  const name = decisionKind(spec);
  if (!name) return [];
  const kind = spec.kinds[name];
  const prefix = kind.id?.prefix ?? "";
  const text = String(block ?? "");
  const asked = new Set(cite.map((c) => c.toLowerCase()));
  const named = typeof task === "string" && /[A-Za-z]/.test(task);
  const out = [];
  for (const item of own(model?.kinds, name)?.items ?? []) {
    const id = `${prefix}${item.id}`;
    if (out.some((d) => d.id === id)) continue;
    const quote = () => quoteOf(root, spec, kind, item);
    const prose = /[A-Za-z]/.test(id) && mentions(text, id);
    if (prose || asked.has(id.toLowerCase())) out.push({ id, text: quote() });
    else if (named) {
      const row = quote();
      if (mentions(row, task)) out.push({ id, text: row });
    }
  }
  return out;
}

/** The decision ids in `cite` that name no decision on the board (as written, any case). */
export function unknownCites({ spec, model, cite }) {
  const name = decisionKind(spec);
  const known = new Set(
    (own(model?.kinds, name)?.items ?? []).map((i) =>
      `${spec.kinds[name].id?.prefix ?? ""}${i.id}`.toLowerCase(),
    ),
  );
  return cite.filter((c) => !known.has(c.toLowerCase()));
}

function quoteOf(root, spec, kind, item) {
  if (kind.at?.table !== undefined) {
    const file = readInside(root, join(root, spec.root ?? ".", item.file));
    const line = file?.split(/\r?\n/)[item.line - 1];
    if (line) return line.trim();
  }
  return Object.entries(item.fields ?? {})
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => `${k}: ${[v].flat().join(", ")}`)
    .join(" · ");
}
