// MemoryService — the memory store aggregate. Holds the in-memory record maps (loaded from the file
// store), keeps the file store (truth) and text index (derived) in sync on writes, and implements the
// fact/episode operations + recall ranking. Graduation analyses (distill/consolidate) live in flows.ts.
import type { Episode, Fact, MemoryType, Scope } from "@agentry/core";
import { DEDUP_THRESHOLD, similarity } from "../domain/dedup.js";
import { newId, originOf, type Origin } from "../domain/id.js";
import type { FileStore, TextIndex } from "../domain/ports.js";
import { recallScore } from "../domain/ranking.js";
import { originForScope, type Roots } from "../resolution/roots.js";

const NEW_FACT_CONFIDENCE = 0.7;

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
    for (const { fact } of this.store.readFacts()) {
      this.facts.set(fact.id, fact);
      if (fact.status === "active") this.index.add(fact.id, this.body(fact));
    }
    for (const { episode } of this.store.readEpisodes()) this.episodes.set(episode.id, episode);
  }

  write(input: WriteInput): WriteResult {
    // dedup-reinforce: a near-duplicate active fact of the same type → reinforce, don't copy.
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

    if (input.supersedes) {
      const old = this.facts.get(input.supersedes);
      if (old) this.save({ ...old, status: "superseded", updatedAt: ts });
    }
    this.create(fact);
    return { id: fact.id, action: "created" };
  }

  recall(input: RecallInput): { memories: ScoredFact[]; episodes?: Episode[] } {
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
    return this.index.search(query, limit).flatMap((hit) => {
      const f = this.facts.get(hit.id);
      return f && f.status === "active"
        ? [{ id: f.id, snippet: f.text.slice(0, 200), type: f.type, scope: f.scope }]
        : [];
    });
  }

  update(id: string, patch: UpdatePatch): { id: string; updated: boolean } {
    const fact = this.facts.get(id);
    if (!fact) return { id, updated: false };
    this.save({ ...fact, ...this.clean(patch), updatedAt: this.iso() });
    return { id, updated: true };
  }

  feedback(input: FeedbackInput): { updated: number } {
    const ts = this.iso();
    const used = new Set(input.used);
    let updated = 0;
    for (const id of new Set([...input.recalled, ...input.used])) {
      const fact = this.facts.get(id);
      if (!fact) continue;
      if (used.has(id)) {
        this.save(
          input.outcome === "pass"
            ? { ...fact, usefulness: fact.usefulness + 1, confidence: Math.min(1, fact.confidence + 0.05), updatedAt: ts }
            : { ...fact, confidence: Math.max(0, fact.confidence - 0.1), updatedAt: ts }, // suspect
        );
      } else {
        this.save({ ...fact, usefulness: Math.max(0, fact.usefulness - 0.25), updatedAt: ts }); // decay
      }
      updated++;
    }
    for (const id of input.recallMisses ?? []) {
      const fact = this.facts.get(id);
      if (fact) {
        this.save({ ...fact, confidence: Math.min(1, fact.confidence + 0.05), updatedAt: ts });
        updated++;
      }
    }
    return { updated };
  }

  stats(): {
    facts: number;
    episodes: number;
    active: number;
    superseded: number;
    undistilled: number;
    byType: Record<string, number>;
  } {
    let active = 0;
    let superseded = 0;
    const byType: Record<string, number> = {};
    for (const f of this.facts.values()) {
      if (f.status === "active") active++;
      else superseded++;
      byType[f.type] = (byType[f.type] ?? 0) + 1;
    }
    let undistilled = 0;
    for (const e of this.episodes.values()) if (!e.distilled) undistilled++;
    return { facts: this.facts.size, episodes: this.episodes.size, active, superseded, undistilled, byType };
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

  stampDistilled(ids: string[]): { stamped: number } {
    let stamped = 0;
    for (const id of ids) {
      const e = this.episodes.get(id);
      if (e && !e.distilled) {
        const next: Episode = { ...e, distilled: true };
        this.store.writeEpisode(originOf(e.id), next);
        this.episodes.set(id, next);
        stamped++;
      }
    }
    return { stamped };
  }

  activeFacts(): Fact[] {
    return [...this.facts.values()].filter((f) => f.status === "active");
  }

  /** Manual-removal override (doc 02 §3): delete a memory from the live store and disk by id. */
  forget(id: string): { forgotten: boolean; kind?: "fact" | "episode" } {
    if (this.facts.delete(id)) {
      this.store.deleteFact(originOf(id), id);
      return { forgotten: true, kind: "fact" };
    }
    if (this.episodes.delete(id)) {
      this.store.deleteEpisode(originOf(id), id);
      return { forgotten: true, kind: "episode" };
    }
    return { forgotten: false };
  }

  // ── internals ──────────────────────────────────────────────────────────
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
