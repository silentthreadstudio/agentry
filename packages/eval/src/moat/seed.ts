// Memory-seeding for the moat dimension — write a durable fact into a sandbox's PROJECT memory BEFORE a warm
// run, so the conductor can recall it. This is the mechanism the moat probe exercises: a prior decision, made
// available to a later task.
//
// ROOT (the hard-won detail, see the moat-probe debug): under `claude -p` the memory layer resolves the project
// root as `CLAUDE_PROJECT_DIR ?? AGENTRY_PROJECT_DIR`, and `claude -p` sets `CLAUDE_PROJECT_DIR` to its OWN cwd —
// the runner's `workingDir`. So project memory lives at `<workingDir>/.agentry/memory`, NOT the sandbox's
// `projectRoot`/`AGENTRY_PROJECT_DIR`. The seed MUST be written under the workingDir or the conductor never sees it.
//
// SRP: writing one validated fact file. It owns the on-disk fact format (frontmatter mirroring `@agentry/core`'s
// `Fact`) and a valid-ULID id generator; it performs no run and reads no stream. The `scope` is constrained to the
// real enum (`user|global|repo`) because an out-of-enum value is silently dropped by the store's Zod decode on
// rebuild — exactly the bug that cost the probe several live runs.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A fact to seed — the fields the conductor's recall needs, mirroring `@agentry/core` `Fact` (minus derived ones). */
export interface FactSeed {
  /** Semantic type (the `@agentry/core` MemoryType enum). */
  type: "gotcha" | "decision" | "preference" | "repo-fact" | "learning" | "gap" | "limitation";
  /** Memory scope — MUST be one of the real enum values; `project` is NOT valid (it is the `p:` id ORIGIN, a
   *  different axis). An out-of-enum scope is silently skipped on the store's rebuild. */
  scope: "user" | "global" | "repo";
  /** The fact body (what recall surfaces and the conductor reads). */
  text: string;
  /** Why it is worth keeping (optional, mirrors the real schema). */
  why?: string;
  /** Retrieval tags. */
  tags?: string[];
  /** Source pointers. */
  provenance?: string[];
  /** The evolution/subject tag (optional). */
  subject?: string;
}

/** Crockford base32 alphabet (no I, L, O, U) — the ULID character set. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generate a valid 26-char Crockford-base32 ULID. The store decodes the `id` as a plain string, but a malformed
 * id has tripped index rebuilds before — so we emit a well-formed one. `seed` varies the random tail
 * deterministically per call site (the probe passes the task index) so two seeds in one run don't collide without
 * relying on a wall clock (kept side-effect-free / testable).
 */
export function newUlid(seed: number): string {
  // `Math.imul` does true 32-bit multiply — plain `*` overflows 2^53 here and silently zeroes the low bits.
  let n = (Math.imul(seed ^ 0x9e3779b9, 2654435761) >>> 0) || 1;
  let out = "";
  for (let i = 0; i < 26; i++) {
    n = (Math.imul(n, 1103515245) + 12345) >>> 0; // a 32-bit-safe LCG step
    out += CROCKFORD[(n >>> 8) % 32]; // high bits → no low-bit periodicity
  }
  // Force the first char ≤ '7' so the (unused) timestamp field is a valid ULID time component.
  return "0" + out.slice(1);
}

/**
 * Write `fact` as a fact `.md` into the workingDir's PROJECT memory (`<workingDir>/.agentry/memory/facts/`), the
 * root the conductor actually reads under `claude -p`. Returns the origin-qualified id (`p:<ULID>`) written. The
 * frontmatter mirrors the real store format so the conductor's rebuild-on-start (and `memory_resync`) indexes it.
 *
 * @param workingDir the run's working dir (the conductor's cwd → its project-memory root).
 * @param fact       the validated fact to seed.
 * @param idSeed     a per-call seed for the ULID tail (the probe passes a task/run index for determinism).
 */
export function seedFact(workingDir: string, fact: FactSeed, idSeed: number): string {
  const ulid = newUlid(idSeed);
  const id = `p:${ulid}`;
  const factsDir = join(workingDir, ".agentry", "memory", "facts");
  mkdirSync(factsDir, { recursive: true });

  const fm: string[] = [
    "---",
    `id: ${id}`,
    `type: ${fact.type}`,
    `scope: ${fact.scope}`,
    "confidence: 0.9",
    "usefulness: 1",
    "status: active",
    "createdAt: 2026-01-01T00:00:00.000Z",
    "updatedAt: 2026-01-01T00:00:00.000Z",
  ];
  if (fact.why !== undefined) fm.push(`why: ${JSON.stringify(fact.why)}`);
  if (fact.subject !== undefined) fm.push(`subject: ${fact.subject}`);
  if (fact.tags !== undefined && fact.tags.length > 0) {
    fm.push("tags:");
    for (const t of fact.tags) fm.push(`  - ${t}`);
  }
  if (fact.provenance !== undefined && fact.provenance.length > 0) {
    fm.push("provenance:");
    for (const p of fact.provenance) fm.push(`  - ${p}`);
  }
  fm.push("---", "", fact.text, "");

  writeFileSync(join(factsDir, `${slug(fact.text)}-${ulid}.md`), fm.join("\n"), "utf8");
  return id;
}

/** A short, filename-safe slug from the fact's leading words (mirrors the store's own slugging intent). */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-");
}
