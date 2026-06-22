// SHARED CONDUCT/JUDGE INFRA (relocated by T-10 from `outcome-judge/result.ts`). It is a primitive the live
// rightsizing probe consumes (`summarizeProducedResult`), so it survived the deletion of `outcome-judge/` and now
// lives in the NEUTRAL `src/conduct/` home — no probe imports another probe's old folder.
//
// The PRODUCED-RESULT reader (ADR-002 / ADR-001 capture-step consumer) — renders the agent-visible produced
// sandbox tree into the bounded, oracle-free TEXT the judge reads. This module owns the "what counts as
// the produced result" contract: which files the judge sees, in what order, and under what size cap. It is PURE
// in the same sense as the rest of the judge core — it may READ the filesystem but does NO spawn / NO
// API; given the same tree it renders byte-identical text (paths sorted, contents size-capped).
//
// ORACLE-FREE BY CONSTRUCTION (ADR-001 / AC5): the captured tree this reads is the SAME pre-floor-injection tree
// the runner captured BEFORE `injectOracle` ran, so the held-out oracle is absent. This reader ADDITIONALLY and
// DEFENSIVELY excludes any `oracle/` subtree, so even a tree read after injection never leaks an oracle file
// into the judged input — the oracle-free guarantee holds by construction, not by trusting call order.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import type { OutcomeFixture } from "./fixture.ts";

/** The top-level subtree the held-out oracle is injected under (`outcome/oracle.ts`'s `injectOracle`). Excluded. */
const ORACLE_SUBTREE = "oracle";

/** Per-file content cap (bytes of UTF-8 text). A file longer than this is truncated with a marker. */
export const DEFAULT_MAX_FILE_BYTES = 8_000;

/** Total rendered-text cap (bytes). Once exceeded, remaining files are omitted with a marker — bounds judge cost. */
export const DEFAULT_MAX_TOTAL_BYTES = 60_000;

/** Tunable caps for {@link summarizeProducedResult} — defaults bound a large tree out of the judge prompt. */
export interface ProducedResultLimits {
  /** Per-file content cap (bytes); a longer file is truncated. Defaults to {@link DEFAULT_MAX_FILE_BYTES}. */
  maxFileBytes?: number;
  /** Total rendered cap (bytes); once crossed, remaining files are omitted. Defaults to {@link DEFAULT_MAX_TOTAL_BYTES}. */
  maxTotalBytes?: number;
}

/**
 * The rendered produced result the outcome judge reads — a bounded, oracle-free, DETERMINISTIC summary of the
 * agent-visible tree. `text` is what the judge prompt embeds (sorted file headers + size-capped contents);
 * `files` is the sorted list of relative paths included; `truncated` flags that a per-file or total cap clipped
 * the rendering (so a reader knows the text is a bounded view, not the whole tree).
 */
export interface ProducedResult {
  /** The fixture id this result was produced for (provenance for the judged artifact). */
  fixtureId: string;
  /** The relative paths included in `text`, sorted (posix-style) — excludes the `oracle/` subtree. */
  files: readonly string[];
  /** The bounded, deterministic rendering the judge reads (file headers + size-capped contents). */
  text: string;
  /** True when a per-file or total-size cap clipped the rendering (the text is a bounded view of the tree). */
  truncated: boolean;
}

/**
 * Render the agent-visible produced tree under `sandboxDir` into a {@link ProducedResult}. Reads the files the
 * task was asked to write — EXCLUDING the top-level `oracle/` subtree — and renders them to deterministic,
 * size-capped text the judge can score. Pure aside from the filesystem reads: no spawn, no API.
 *
 * Determinism: relative paths are sorted; each file is rendered as a `--- <path> ---` header followed by its
 * (UTF-8) contents, capped at `maxFileBytes`. Bounding: once the accumulated text would exceed `maxTotalBytes`,
 * remaining files are listed but their contents omitted, so a large tree cannot blow the judge prompt / cost.
 */
export function summarizeProducedResult(
  sandboxDir: string,
  fixture: OutcomeFixture,
  limits: ProducedResultLimits = {},
): ProducedResult {
  const maxFileBytes = limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  const files = producedFiles(sandboxDir).sort();

  const sections: string[] = [];
  let total = 0;
  let truncated = false;

  for (const path of files) {
    const raw = readFileSync(join(sandboxDir, path), "utf8");
    const { content, clipped } = capFile(raw, maxFileBytes);
    if (clipped) truncated = true;

    const section = `--- ${path} ---\n${content}\n`;
    if (total + section.length > maxTotalBytes) {
      // The total cap is reached: list the remaining files by path (so the judge knows they exist) but omit
      // their contents — bounding the prompt while keeping the rendering deterministic and honest.
      sections.push(`--- ${path} --- [omitted: total size cap reached]\n`);
      truncated = true;
      continue;
    }
    sections.push(section);
    total += section.length;
  }

  return { fixtureId: fixture.id, files, text: sections.join("\n"), truncated };
}

/**
 * List every FILE under `sandboxDir` as a posix-style relative path, EXCLUDING anything under the top-level
 * `oracle/` subtree (the held-out tests `injectOracle` copies in). The exclusion is by top-level segment, so a
 * file legitimately named `oracle.js` at the root is kept — only the `oracle/` directory is dropped.
 */
function producedFiles(sandboxDir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const abs = join(current, entry);
      const rel = relative(sandboxDir, abs).split(/[\\/]/).join("/");
      if (rel === ORACLE_SUBTREE || rel.startsWith(`${ORACLE_SUBTREE}/`)) continue;
      if (statSync(abs).isDirectory()) {
        walk(abs);
      } else {
        out.push(rel);
      }
    }
  };
  walk(sandboxDir);
  return out;
}

/** Cap a file's content to `maxBytes`, appending a truncation marker when clipped. Returns the clip flag too. */
function capFile(content: string, maxBytes: number): { content: string; clipped: boolean } {
  if (content.length <= maxBytes) return { content, clipped: false };
  return { content: `${content.slice(0, maxBytes)}\n[truncated: file exceeds ${maxBytes} bytes]`, clipped: true };
}
