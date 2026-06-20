// memory-view — the Memory page's PURE view-model (the moat browser, design/memory.html). Sits beside
// Memory.tsx the way works-kpis.ts sits beside Works.tsx: the route owns the CSS import + the JSX, this
// module owns the deriveable shape so it is unit-testable without a DOM or a stylesheet. Maps a record's
// loose YAML frontmatter (the store's field contract: type/tags/why/provenance/confidence/usefulness/
// createdAt + the body under text/task) to a display row, derives the six metric tiles, and applies the
// three client-side filters (kind segment × type chip × origin segment), plus the type-badge tint + the
// read-only markdown render (markdown-it, the renderer the doc layer already bundles). No I/O, no React
// components/hooks (the CSSProperties return is a type only).
import type { CSSProperties } from "react";
import MarkdownIt from "markdown-it";
import type { MemReadRecord } from "../api/index.js";

// The body field name per record kind (the reader re-attaches the prose here: a fact's `text`, an
// episode's `task`).
const BODY_FIELD: Record<MemReadRecord["kind"], string> = { facts: "text", episodes: "task" };

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}
function strList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(str).filter((v) => v.length > 0);
  const one = str(value).trim();
  return one ? [one] : [];
}
function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

// ── View model ──────────────────────────────────────────────────────────────────────────────────────────
// A record's display shape: a kind ("facts"/"episodes"), a type label (gotcha/decision/repo-fact/…, with an
// episode falling back to "episode"), the origin, the body prose, the first-line title (the card's 2-line
// summary + the detail's H1), tags, why, provenance ids, and the numeric confidence/usefulness/createdAt.
export interface MemRow {
  id: string;
  kind: MemReadRecord["kind"];
  type: string;
  origin: "global" | "project";
  title: string;
  body: string;
  tags: string[];
  why: string;
  provenance: string[];
  confidence?: number;
  usefulness?: number;
  createdAt: string;
}

/** The first sentence / line of the body, clamped — the human-scannable headline for a record. */
function titleOf(body: string): string {
  const firstLine = body.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  const head = sentence.length > 0 ? sentence : firstLine;
  return head.length > 140 ? `${head.slice(0, 139).trimEnd()}…` : head;
}

export function toMemRow(record: MemReadRecord): MemRow {
  const f = record.fields;
  const body = str(f[BODY_FIELD[record.kind]]).trim();
  const type = str(f.type).trim() || (record.kind === "episodes" ? "episode" : "fact");
  const confidence = num(f.confidence);
  const usefulness = num(f.usefulness);
  return {
    id: record.id,
    kind: record.kind,
    type,
    origin: record.origin,
    title: titleOf(body) || "(no title)",
    body: body || "_(no body)_",
    tags: strList(f.tags),
    why: str(f.why).trim(),
    provenance: strList(f.provenance ?? f.source ?? f.run),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(usefulness !== undefined ? { usefulness } : {}),
    createdAt: str(f.createdAt).slice(0, 10),
  };
}

// ── Type tones ──────────────────────────────────────────────────────────────────────────────────────────
// The mockup's swatch family, read from the page's local CSS vars (.mem sets --gotcha/--decision/--repo/
// --pref/--fact/--epi/--learning off the tokens). Color is a SECONDARY cue; the text label carries meaning.
// An unknown type falls back to the faint ink.
const TYPE_VAR: Record<string, string> = {
  gotcha: "--gotcha",
  decision: "--decision",
  "repo-fact": "--repo",
  preference: "--pref",
  learning: "--learning",
  fact: "--fact",
  episode: "--epi",
};
export function typeColor(type: string): string {
  return `var(${TYPE_VAR[type] ?? "--faint"})`;
}

/** The type badge's tint — the type hue at low alpha over the panel (the mockup's #2a1714 etc). */
export function typeBadge(type: string): CSSProperties {
  const c = typeColor(type);
  return { color: c, background: `color-mix(in srgb, ${c} 16%, var(--panel))` };
}

// Read-only markdown render of local file content (markdown-it the doc layer already bundles).
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
export function renderMemoryMarkdown(body: string): string {
  return md.render(body);
}

// ── Metrics (derived counts — the six tiles) ────────────────────────────────────────────────────────────
export interface Metric {
  k: string;
  v: number;
  color: string;
}
export function metricsFor(records: MemReadRecord[]): Metric[] {
  const rows = records.map(toMemRow);
  const byType = (t: string) => rows.filter((r) => r.type === t).length;
  return [
    { k: "Total", v: rows.length, color: "var(--ink)" },
    { k: "Facts", v: rows.filter((r) => r.kind === "facts").length, color: typeColor("fact") },
    { k: "Episodes", v: rows.filter((r) => r.kind === "episodes").length, color: typeColor("episode") },
    { k: "Gotchas", v: byType("gotcha"), color: typeColor("gotcha") },
    { k: "Repo-facts", v: byType("repo-fact"), color: typeColor("repo-fact") },
    { k: "Decisions", v: byType("decision"), color: typeColor("decision") },
  ];
}

// ── Filters (client-side) ───────────────────────────────────────────────────────────────────────────────
export type KindFilter = "all" | "facts" | "episodes";
export type OriginFilter = "all" | "project" | "global";

/** The full client-side filter: kind segment, type chip ("all" = no type filter), origin segment. Search is
 *  applied at the server (?q=) so it is NOT re-applied here — these three facets narrow the fetched list. */
export function applyFilters(
  rows: MemRow[],
  kind: KindFilter,
  type: string,
  origin: OriginFilter,
): MemRow[] {
  return rows.filter(
    (r) =>
      (kind === "all" || r.kind === kind) &&
      (type === "all" || r.type === type) &&
      (origin === "all" || r.origin === origin),
  );
}
