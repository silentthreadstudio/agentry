// MemoryService — the memory store aggregate. Holds the in-memory record maps (loaded from the file
// store), keeps the file store (truth) and text index (derived) in sync on writes, and implements the
// fact/episode operations + recall ranking. Graduation analyses (distill/consolidate) live in flows.ts.
import type { Episode, Fact, MemoryType, Scope } from "@agentry/core";
import { DEDUP_THRESHOLD, similarity } from "../domain/dedup.js";
import { newId, originOf, type Origin } from "../domain/id.js";
import type { FileStore, ReadError, StoreSignature, TextIndex } from "../domain/ports.js";
import { recallScore } from "../domain/ranking.js";
import { originForScope, type Roots } from "../resolution/roots.js";

const NEW_FACT_CONFIDENCE = 0.7;
const ARCHIVE_THRESHOLD = 4; // recalled-but-unused strikes before self-archive (benchmark knob, doc 02 §7)

export interface WriteInput {
  type: MemoryType;
  scope: Scope;
  text: string;
  why?: string;
  tags?: string[];
  subject?: string;
  repoId?: string;
  supersedes?: string;
  provenance?: string[];
}
export interface WriteResult {
  id: string;
  action: "created" | "reinforced";
  // Present (= the bogus supersedes id) ONLY when `supersedes` was requested but no such fact existed.
  // The write still succeeds — this flags the link as a no-op so the caller isn't misled (Q3 / AC6).
  // Absent on the happy path (AC9 additive-only).
  supersededMissing?: string;
}

// ── Service outcomes — typed discriminated unions the adapters switch on (ADR-001 §B). The service
//    emits a category + the offending value; it never builds an envelope and never throws for an
//    expected failure. Envelope prose lives in tools/errors.ts at the adapter boundary.

export type UpdateOutcome =
  | { ok: true; id: string }
  | { ok: false; reason: "bad-input"; field: string; rule: string }
  | { ok: false; reason: "not-found"; id: string };

export type ForgetOutcome =
  | { ok: true; id: string; kind: "fact" | "episode" }
  | { ok: false; reason: "bad-input"; field: string; rule: string }
  | { ok: false; reason: "not-found"; id: string };

export type RecoverOutcome =
  | { ok: true; id: string }
  | { ok: false; reason: "bad-input"; field: string; rule: string }
  | { ok: false; reason: "not-found"; id: string }
  | { ok: false; reason: "invalid-state"; id: string; status: Fact["status"] };

// Per-id partial model (feedback + distill-stamp): applied ids and skipped ids each with a reason.
// All-ids-invalid (applied empty AND ≥1 id requested) is detected by the adapter → not-found error (Q2).
export interface PartialOutcome {
  applied: string[];
  skipped: { id: string; reason: string }[];
  requested: number;
}

export interface RecallInput {
  query?: string;
  limit?: number;
  mode?: "task" | "prime";
}
export interface ScoredFact {
  fact: Fact;
  score: number;
}

export interface UpdatePatch {
  text?: string;
  tags?: string[];
  type?: MemoryType;
  scope?: Scope;
  confidence?: number;
  status?: "active" | "superseded";
  supersedes?: string;
}

export interface FeedbackInput {
  recalled: string[];
  used: string[];
  outcome: "pass" | "fail";
  recallMisses?: string[];
}

export interface EpisodeInput {
  task: string;
  shape: string;
  outcome: string;
  retries?: number;
  lesson?: string;
  usedMemories?: string[];
  recallMisses?: string[];
  repoId?: string;
}

export class MemoryService {
  private readonly facts = new Map<string, Fact>();
  private readonly episodes = new Map<string, Episode>();
  // Read-errors collected at the last load() — corrupt/unreadable store records the file store could not
  // parse. Surfaced through stats() so memory_stats can report them (Q1); never silently swallowed.
  private readErrors: ReadError[] = [];
  // Freshness fingerprint captured at the end of the last load() (ADR-001). ensureFresh() re-probes and
  // compares against this to detect out-of-band writes; null until the first load().
  private signature: StoreSignature | null = null;

  constructor(
    private readonly store: FileStore,
    private readonly index: TextIndex,
    private readonly roots: Roots,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Load the file store into memory and (re)build the text index. Call once at startup. */
  load(): void {
    this.facts.clear();
    this.episodes.clear();
    this.index.reset();
    this.readErrors = [];
    const facts = this.store.readFacts();
    for (const { fact } of facts.records) {
      this.facts.set(fact.id, fact);
      if (fact.status === "active") this.index.add(fact.id, this.body(fact));
    }
    const episodes = this.store.readEpisodes();
    for (const { episode } of episodes.records) this.episodes.set(episode.id, episode);
    this.readErrors = [...facts.errors, ...episodes.errors];
    // Capture the freshness fingerprint of the just-loaded store; ensureFresh() compares against it.
    this.signature = this.store.signature();
  }

  write(input: WriteInput): WriteResult {
    // dedup-reinforce: a near-duplicate active fact of the same type → reinforce, don't copy.
    // Skipped when an explicit `supersedes` is requested: that is a deliberate create-and-retire, and
    // the dedup early-return would otherwise swallow it (reinforce-and-return before supersedes is ever
    // applied) — leaving the to-be-retired fact active forever and silently misleading the caller.
    if (!input.supersedes)
      for (const fact of this.facts.values()) {
      if (
        fact.status === "active" &&
        fact.type === input.type &&
        similarity(fact.text, input.text) >= DEDUP_THRESHOLD
      ) {
        this.save({
          ...fact,
          usefulness: fact.usefulness + 1,
          confidence: Math.min(1, fact.confidence + 0.05),
          updatedAt: this.iso(),
        });
        return { id: fact.id, action: "reinforced" };
      }
    }

    const ts = this.iso();
    const origin = originForScope(input.scope, this.roots);
    const fact: Fact = {
      id: newId(origin),
      type: input.type,
      scope: input.scope,
      text: input.text,
      confidence: NEW_FACT_CONFIDENCE,
      usefulness: 0,
      decay: 0,
      status: "active",
      createdAt: ts,
      updatedAt: ts,
      ...(input.why !== undefined ? { why: input.why } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.repoId !== undefined ? { repoId: input.repoId } : {}),
      ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
      ...(input.provenance ? { provenance: input.provenance } : {}),
    };

    let supersededMissing: string | undefined;
    if (input.supersedes) {
      const old = this.facts.get(input.supersedes);
      if (old) this.save({ ...old, status: "superseded", updatedAt: ts });
      else supersededMissing = input.supersedes; // requested a supersession of an id that doesn't exist
    }
    this.create(fact);
    return {
      id: fact.id,
      action: "created",
      ...(supersededMissing !== undefined ? { supersededMissing } : {}),
    };
  }

  recall(input: RecallInput): { memories: ScoredFact[]; episodes?: Episode[] } {
    this.ensureFresh();
    const limit = input.limit ?? 5;
    if (input.mode === "prime") {
      const memories = this.activeFacts()
        .map((fact) => ({ fact, score: recallScore(fact, 1) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      const episodes = [...this.episodes.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
      return { memories, episodes };
    }
    if (!input.query) return { memories: [] };
    const scored: ScoredFact[] = [];
    for (const hit of this.index.search(input.query, limit * 4)) {
      const fact = this.facts.get(hit.id);
      if (fact && fact.status === "active") scored.push({ fact, score: recallScore(fact, hit.relevance) });
    }
    scored.sort((a, b) => b.score - a.score);
    return { memories: scored.slice(0, limit) };
  }

  search(query: string, limit = 10): { id: string; snippet: string; type: MemoryType; scope: Scope }[] {
    this.ensureFresh();
    return this.index.search(query, limit).flatMap((hit) => {
      const f = this.facts.get(hit.id);
      return f && f.status === "active"
        ? [{ id: f.id, snippet: f.text.slice(0, 200), type: f.type, scope: f.scope }]
        : [];
    });
  }

  update(id: string, patch: UpdatePatch): UpdateOutcome {
    if (id.trim() === "") return { ok: false, reason: "bad-input", field: "id", rule: "a non-empty id" };
    const fact = this.facts.get(id);
    if (!fact) return { ok: false, reason: "not-found", id };
    this.save({ ...fact, ...this.clean(patch), updatedAt: this.iso() });
    return { ok: true, id };
  }

  feedback(input: FeedbackInput): PartialOutcome {
    const ts = this.iso();
    const used = new Set(input.used);
    const applied: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    const recalledUsed = new Set([...input.recalled, ...input.used]);
    for (const id of recalledUsed) {
      const fact = this.facts.get(id);
      // Recall only ever returns active facts, so a non-active id in recalled/used is illegitimate —
      // never mutate it (supersession is terminal, doc 02 §42; archived facts decay only via recover).
      if (!fact) {
        skipped.push({ id, reason: "no such fact exists" });
        continue;
      }
      if (fact.status !== "active") {
        skipped.push({ id, reason: `fact is '${fact.status}', not active` });
        continue;
      }
      if (used.has(id)) {
        this.save(
          input.outcome === "pass"
            ? // cited + helped: boost and clear strikes — a used fact is alive
              { ...fact, usefulness: fact.usefulness + 1, confidence: Math.min(1, fact.confidence + 0.05), decay: 0, updatedAt: ts }
            : // suspect: lower confidence, but it was relevant/used — don't strike toward archive
              { ...fact, confidence: Math.max(0, fact.confidence - 0.1), decay: 0, updatedAt: ts },
        );
      } else {
        // recalled, not used: decay usefulness and add a strike; self-archive once strikes cross the
        // threshold AND usefulness has floored at 0 (a fresh fact at 0 isn't archived until it earns strikes).
        const newUsefulness = Math.max(0, fact.usefulness - 0.25);
        const newDecay = fact.decay + 1;
        const archive = newDecay >= ARCHIVE_THRESHOLD && newUsefulness === 0;
        this.save({
          ...fact,
          usefulness: newUsefulness,
          decay: newDecay,
          updatedAt: ts,
          ...(archive ? { status: "archived" as const, archivedAt: ts } : {}),
        });
      }
      applied.push(id);
    }
    for (const id of input.recallMisses ?? []) {
      if (recalledUsed.has(id)) continue; // already counted above — don't double-report
      const fact = this.facts.get(id);
      if (fact) {
        this.save({ ...fact, confidence: Math.min(1, fact.confidence + 0.05), updatedAt: ts });
        applied.push(id);
      } else {
        skipped.push({ id, reason: "no such fact exists" });
      }
    }
    const requested = recalledUsed.size + (input.recallMisses ?? []).filter((id) => !recalledUsed.has(id)).length;
    return { applied, skipped, requested };
  }

  stats(): {
    facts: number;
    episodes: number;
    active: number;
    superseded: number;
    archived: number;
    undistilled: number;
    byType: Record<string, number>;
    readErrors: ReadError[];
  } {
    this.ensureFresh();
    let active = 0;
    let superseded = 0;
    let archived = 0;
    const byType: Record<string, number> = {};
    for (const f of this.facts.values()) {
      if (f.status === "active") active++;
      else if (f.status === "archived") archived++;
      else superseded++;
      byType[f.type] = (byType[f.type] ?? 0) + 1;
    }
    let undistilled = 0;
    for (const e of this.episodes.values()) if (!e.distilled) undistilled++;
    return {
      facts: this.facts.size,
      episodes: this.episodes.size,
      active,
      superseded,
      archived,
      undistilled,
      byType,
      readErrors: this.readErrors,
    };
  }

  episodeWrite(input: EpisodeInput): { id: string } {
    const origin: Origin = this.roots.project ? "p" : "g";
    const episode: Episode = {
      id: newId(origin),
      task: input.task,
      shape: input.shape,
      outcome: input.outcome,
      distilled: false,
      createdAt: this.iso(),
      ...(input.retries !== undefined ? { retries: input.retries } : {}),
      ...(input.lesson !== undefined ? { lesson: input.lesson } : {}),
      ...(input.usedMemories ? { usedMemories: input.usedMemories } : {}),
      ...(input.recallMisses ? { recallMisses: input.recallMisses } : {}),
      ...(input.repoId !== undefined ? { repoId: input.repoId } : {}),
    };
    this.store.writeEpisode(origin, episode);
    this.episodes.set(episode.id, episode);
    return { id: episode.id };
  }

  undistilledEpisodes(): Episode[] {
    return [...this.episodes.values()].filter((e) => !e.distilled);
  }

  stampDistilled(ids: string[]): PartialOutcome {
    const applied: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of ids) {
      const e = this.episodes.get(id);
      if (!e) {
        skipped.push({ id, reason: "no such episode exists" });
        continue;
      }
      if (e.distilled) {
        skipped.push({ id, reason: "episode is already distilled" });
        continue;
      }
      const next: Episode = { ...e, distilled: true };
      this.store.writeEpisode(originOf(e.id), next);
      this.episodes.set(id, next);
      applied.push(id);
    }
    return { applied, skipped, requested: ids.length };
  }

  activeFacts(): Fact[] {
    return [...this.facts.values()].filter((f) => f.status === "active");
  }

  /**
   * Restore a tombstoned (archived) fact back to active — the recover side of auto-decay (doc 02 §3).
   * Clears the strike counter and tombstone. Because save() does not re-index, also re-add the fact to
   * the text index so it's immediately searchable again (task mode) without waiting for a full load().
   * Splits failure (ADR-001 §B): id absent → not-found; present but not archived → invalid-state
   * (carrying the actual status so the adapter can distinguish the two for the caller).
   */
  recover(id: string): RecoverOutcome {
    if (id.trim() === "") return { ok: false, reason: "bad-input", field: "id", rule: "a non-empty id" };
    const fact = this.facts.get(id);
    if (!fact) return { ok: false, reason: "not-found", id };
    if (fact.status !== "archived") return { ok: false, reason: "invalid-state", id, status: fact.status };
    const restored: Fact = { ...fact, status: "active", decay: 0, updatedAt: this.iso() };
    delete restored.archivedAt;
    this.save(restored);
    this.index.add(id, this.body(restored));
    return { ok: true, id };
  }

  /** Manual-removal override (doc 02 §3): delete a memory from the live store and disk by id. */
  forget(id: string): ForgetOutcome {
    if (id.trim() === "") return { ok: false, reason: "bad-input", field: "id", rule: "a non-empty id" };
    if (this.facts.delete(id)) {
      this.store.deleteFact(originOf(id), id);
      return { ok: true, id, kind: "fact" };
    }
    if (this.episodes.delete(id)) {
      this.store.deleteEpisode(originOf(id), id);
      return { ok: true, id, kind: "episode" };
    }
    return { ok: false, reason: "not-found", id };
  }

  /**
   * Manual force-rebuild (ADR-001 §b): re-read the file store (truth) into the maps/index regardless of
   * the freshness signature, and report the fact/episode counts before and after. The escape hatch when
   * another process wrote memories this session can't see. `rebuilt` reflects whether a count moved (the
   * rebuild itself always runs — that is the "force" semantics).
   */
  resync(): {
    rebuilt: boolean;
    before: { facts: number; episodes: number };
    after: { facts: number; episodes: number };
  } {
    // Read `before` from the CURRENT maps first — load() clears them before repopulating.
    const before = { facts: this.facts.size, episodes: this.episodes.size };
    this.load();
    const after = { facts: this.facts.size, episodes: this.episodes.size };
    return {
      rebuilt: before.facts !== after.facts || before.episodes !== after.episodes,
      before,
      after,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────
  /**
   * Cheap freshness guard (ADR-001 §a): re-probe the store's stat-signature and, only on mismatch (or
   * before the first load), rebuild via the idempotent load(). When nothing changed on disk the fresh
   * path is just a tuple compare — no rebuild. Runs at the top of every disk-truth-dependent read.
   */
  private ensureFresh(): void {
    const sig = this.store.signature();
    if (
      this.signature === null ||
      sig.count !== this.signature.count ||
      sig.maxMtimeMs !== this.signature.maxMtimeMs
    ) {
      this.load(); // re-captures this.signature
    }
  }

  private create(fact: Fact): void {
    this.store.writeFact(originOf(fact.id), fact);
    this.facts.set(fact.id, fact);
    this.index.add(fact.id, this.body(fact));
  }

  /** Update an existing fact (no re-index; recall filters superseded via the map's status). */
  private save(fact: Fact): void {
    this.store.writeFact(originOf(fact.id), fact);
    this.facts.set(fact.id, fact);
  }

  private body(fact: Fact): string {
    return [fact.text, fact.why ?? "", (fact.tags ?? []).join(" ")].join(" ").trim();
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private clean(patch: UpdatePatch): UpdatePatch {
    const out: UpdatePatch = {};
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    return out;
  }
}
