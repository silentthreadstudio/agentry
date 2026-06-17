// Loads the CURATED corrections log (doc 08 §6 — "the corrections log is the product"). Unlike routing/quality,
// this content is NOT derived from a run: it is the human-maintained record of times the meter disagreed with the
// conductor and the conductor was right. It lives in a JSON file the reporter reads if present.
//
// SRP: one optional input, parsed defensively. A missing/empty/malformed file yields `[]` — the dashboard simply
// renders an empty corrections view rather than failing the whole report. JSON (not YAML) so it parses with no
// dependency, consistent with the repo's no-shipped-deps stance.

import { existsSync, readFileSync } from "node:fs";

import type { Correction } from "./model.ts";

/**
 * Read the curated corrections file (a JSON array of {@link Correction}). Returns `[]` when `path` is undefined, the
 * file is absent, or the contents don't parse to an array — corrections are an optional, additive trust section, so
 * their absence must never break a report. Each entry is shallow-validated; rows missing required fields are dropped.
 */
export function loadCorrections(path?: string): Correction[] {
  if (path === undefined || !existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isCorrection);
}

/** Shallow guard: an entry must carry the fields the template reads, or it's skipped (a malformed row, not a crash). */
function isCorrection(x: unknown): x is Correction {
  if (x === null || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  return (
    typeof c.date === "string" &&
    typeof c.h === "string" &&
    typeof c.meter === "string" &&
    typeof c.truth === "string" &&
    typeof c.fix === "string"
  );
}
