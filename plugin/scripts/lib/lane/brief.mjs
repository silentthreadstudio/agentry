// brief — what an exec round's brief says, rendered from the templates in the conducting skill's
// `references/briefs/` (ADR-R3): the same brief every time, on disk, quoting the board instead of memory.
//
//   ownedFiles      the paths the contract's "owns" names (backticked), in order
//   suggestBuilder  designer when an owned path is UI-shaped, else implementer (the conductor decides, #20)
//   citedDecisions  every decision of the board's decision kind the block cites by id, its row quoted
//   recalledFacts   the memory facts ranked for the owned files, only when `memory.prime` is "all": this
//                   repo's store, the user's own and cross-project (`scope: user|global`) facts,
//                   never another project's
//   renderBrief     a template filled; every `{{slot}}` must be given, so a template can't drift silently
//
// Reads the board's files and the memory store; writes nothing. Node built-ins only.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rankFacts, readFacts, readMemoryConfig } from "../memory/recall.mjs";
import { readInside } from "../process/read.mjs";
import { own } from "../process/spec.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEMPLATES = join(
  HERE,
  "..",
  "..",
  "..",
  "skills",
  "conducting",
  "references",
  "briefs",
);

// The template each dispatch step renders.
const TEMPLATE_OF = {
  build: "build",
  fix: "fix",
  "needs-context": "fix",
  verify: "verify",
  recheck: "verify",
  final: "final",
};

// Where a contract's own-list ends: the next labelled part of the contract.
const OWNS = /\bowns?\b\s*[:*]*/i;
const NEXT_PART = /\b(exposes|excludes|deps|accept(?:ance)?|out of scope|goal|rules)\b\s*[:*]/i;
const TICKED = /`([^`\n]+)`/g;
const PATHISH = /[/.*]/;

/** The paths the block's "owns" part names in backticks, de-duplicated, in order. Empty when the block
 *  has no "owns" part or it names no path. */
export function ownedFiles(block) {
  const text = String(block ?? "");
  const at = OWNS.exec(text);
  if (!at) return [];
  let part = text.slice(at.index + at[0].length);
  const end = NEXT_PART.exec(part);
  if (end) part = part.slice(0, end.index);
  const out = [];
  for (const [, token] of part.matchAll(TICKED)) {
    const path = token.trim();
    if (PATHISH.test(path) && !/\s/.test(path) && !out.includes(path)) out.push(path);
  }
  return out;
}

const UI_DIRS = new Set([
  "ui",
  "components",
  "screens",
  "views",
  "pages",
  "styles",
  "theme",
  "themes",
]);
const UI_EXT = /\.(css|scss|sass|less|vue|svelte|html|tscn)$/i;

/** Which builder the owned paths suggest: `{ agent, why }`. A suggestion: the conductor decides. */
export function suggestBuilder(owned) {
  const ui = owned.find(
    (path) => UI_EXT.test(path) || path.split("/").some((part) => UI_DIRS.has(part.toLowerCase())),
  );
  return ui
    ? { agent: "designer", why: `${ui} is UI-shaped` }
    : { agent: "implementer", why: "no owned path is UI-shaped" };
}

/** The board's decision kind: the one `drafts.decision` names, else a kind called "decision". */
export function decisionKind(spec) {
  const named = own(own(spec?.drafts, "decision"), "kind");
  if (typeof named === "string" && own(spec?.kinds, named)) return named;
  return own(spec?.kinds, "decision") ? "decision" : null;
}

const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every decision the block cites, as `{ id, text }`: `id` as the board writes it (the kind's display
 *  `prefix` + its id, `D12`), `text` its table row quoted from the file (or its fields for a
 *  one-file-per-item kind). An id made of digits only is never matched in prose. */
export function citedDecisions({ root, spec, model, block }) {
  const name = decisionKind(spec);
  if (!name) return [];
  const kind = spec.kinds[name];
  const prefix = kind.id?.prefix ?? "";
  const text = String(block ?? "");
  const out = [];
  for (const item of own(model?.kinds, name)?.items ?? []) {
    const id = `${prefix}${item.id}`;
    if (!/[A-Za-z]/.test(id) || out.some((d) => d.id === id)) continue;
    if (!new RegExp(`(?<![A-Za-z0-9_-])${literal(id)}(?![A-Za-z0-9_])`).test(text)) continue;
    out.push({ id, text: quoteOf(root, spec, kind, item) });
  }
  return out;
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

// A brief may carry what this repo's store holds, plus the user's own (`scope: user`) and the
// cross-project (`scope: global`) facts from the home store. The home store also keeps facts written
// for other projects (a `repo` fact with no project store goes there) and unscoped ones: those never
// belong in this repo's brief.
export const forThisRepo = (fact) =>
  fact.source === "project" || fact.scope === "user" || fact.scope === "global";

/** How many ranked facts a prime may carry: the config's `primeLimit` when a whole number above 0, else 5. */
export const primeLimitOf = (config) =>
  Number.isInteger(config.primeLimit) && config.primeLimit > 0 ? config.primeLimit : 5;

/** The facts recalled for this contract: `{ prime, facts }`. Facts only when the repo's
 *  `memory.prime` is "all" (briefs are primed); otherwise none. */
export function recalledFacts(root, { owned, block }) {
  const config = readMemoryConfig(root);
  if (config.prime !== "all") return { prime: config.prime, facts: [] };
  const head = String(block ?? "")
    .split("\n")
    .slice(0, 2)
    .join(" ");
  const task = [...owned, head].join(" ");
  return {
    prime: config.prime,
    facts: rankFacts(readFacts(root).filter(forThisRepo), task, primeLimitOf(config)),
  };
}

/** The slots and section names a template uses, in order of first use. */
export const slotsOf = (template) => [
  ...new Set([...template.matchAll(/\{\{[#/]?(\w+)\}\}/g)].map((m) => m[1])),
];

const SECTION = /^\{\{#(\w+)\}\}\n([\s\S]*?)^\{\{\/\1\}\}\n?/gm;

/** `template` with every `{{slot}}` filled from `values`. A section `{{#name}}` … `{{/name}}` (each
 *  marker on its own line) is kept only when `values[name]` is truthy. A slot or section without a
 *  value is an error, never left blank. A line that is only a slot whose value is empty goes, with the
 *  blank line after it, so an absent part leaves no gap; the values themselves are put in as given. */
export function fill(template, values) {
  const missing = slotsOf(template).filter((s) => !Object.hasOwn(values, s));
  if (missing.length) throw new Error(`brief slots without a value: ${missing.join(", ")}`);
  const lines = template
    .replace(SECTION, (_, name, body) => (values[name] ? body : ""))
    .split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const only = /^\{\{(\w+)\}\}$/.exec(lines[i].trim());
    if (only && String(values[only[1]]) === "") {
      if (lines[i + 1]?.trim() === "") i++;
      continue;
    }
    kept.push(lines[i]);
  }
  return `${kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\{\{(\w+)\}\}/g, (_, s) => String(values[s]))
    .trimEnd()}\n`;
}

// A fix round's brief wraps the build brief, a final round's the verify brief: each rule is written once.
const WRAPS = { fix: "build", final: "verify" };
const read = (name) => readFileSync(join(TEMPLATES, `${name}.md`), "utf8");
const body = (text) => text.replace(/^# .*\n+/, "");

/** The brief for dispatch `step`, rendered from its template (with the brief it wraps as `{{inner}}`). */
export function renderBrief(step, values) {
  const name = Object.hasOwn(TEMPLATE_OF, step) ? TEMPLATE_OF[step] : null;
  if (!name) throw new Error(`no brief template for step "${step}"`);
  const inner = Object.hasOwn(WRAPS, name) ? body(fill(read(WRAPS[name]), values)) : "";
  return fill(read(name), { ...values, inner });
}

/** A list as brief lines (`- item`), or `none`. */
export const bullets = (items) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "none");
