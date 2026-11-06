// MemoryService — the memory store aggregate. Holds the in-memory record maps and the text index, both
// loaded from the file store (truth), and implements the fact/episode operations + recall ranking. The
// feedback rules live in feedback.mjs, the graduation analyses (distill/consolidate) in flows.mjs.
//
// Freshness: the maps are updated on every write, but the text index is only ever rebuilt by load(),
// never patched. Every write marks the loaded view stale, so the next search/recall/stats reloads it.
// Search after update() or recover() is right because of that reload, not because a write happened to
// move a file mtime.
//
// An expected failure is never thrown: update / forget / recover return an outcome,
//   { ok: true, id, … } | { ok: false, reason: "bad-input", field, rule }
//   | { ok: false, reason: "not-found", id } | { ok: false, reason: "invalid-state", id, status }
// and the adapters (tools/) turn the reason into the error the caller sees.
//
// new MemoryService(store, index, roots, now = Date.now)
//   store: the file store (persistence/file-store.mjs); index: the text index (persistence/db-index.mjs)
import { DEDUP_THRESHOLD, similarity } from "../domain/dedup.mjs";
import { newId, originOf } from "../domain/id.mjs";
import { recallScore } from "../domain/ranking.mjs";
import { originForScope } from "../resolution/roots.mjs";
import { applyFeedback } from "./feedback.mjs";

const NEW_FACT_CONFIDENCE = 0.7;

const badInput = (field, rule) => ({ ok: false, reason: "bad-input", field, rule });
const blankId = () => badInput("id", "a non-empty id");

export class MemoryService {
  #store;
  #index;
  #roots;
  #now;
  #facts = new Map();
  #episodes = new Map();
  // Read-errors collected at the last load(): corrupt/unreadable store records the file store could not
  // parse. Surfaced through stats(); never silently swallowed.
  #readErrors = [];
  // Freshness fingerprint captured at the end of the last load(). ensureFresh() re-probes and compares
  // against this to detect out-of-band writes. null = the view is stale and the next read reloads:
  // before the first load(), and after each of this service's own writes (see #stale()).
  #signature = null;

  constructor(store, index, roots, now = () => Date.now()) {
    this.#store = store;
    this.#index = index;
    this.#roots = roots;
    this.#now = now;
  }

  /** Load the file store into memory and (re)build the text index. Call once at startup. */
  load() {
    this.#facts.clear();
    this.#episodes.clear();
    this.#index.reset();
    this.#readErrors = [];
    const facts = this.#store.readFacts();
    for (const { fact } of facts.records) {
      this.#facts.set(fact.id, fact);
      if (fact.status === "active") this.#index.add(fact.id, this.#body(fact));
    }
    const episodes = this.#store.readEpisodes();
    for (const { episode } of episodes.records) this.#episodes.set(episode.id, episode);
    this.#readErrors = [...facts.errors, ...episodes.errors];
    // Capture the freshness fingerprint of the just-loaded store; ensureFresh() compares against it.
    this.#signature = this.#store.signature();
  }

  /**
   * write({ type, scope, text, why?, tags?, subject?, repoId?, supersedes?, provenance? })
   *   -> { id, action: "created" | "reinforced", supersededMissing? }
   * supersededMissing is present (= the bogus supersedes id) ONLY when `supersedes` named no existing
   * fact: the write still succeeds, and the field says the link was a no-op.
   */
  write(input) {
    // dedup-reinforce: a near-duplicate active fact of the same type -> reinforce, don't copy.
    // Skipped when an explicit `supersedes` is requested: that is a deliberate create-and-retire, and
    // the dedup early-return would otherwise swallow it (reinforce-and-return before supersedes is ever
    // applied) — leaving the to-be-retired fact active forever and silently misleading the caller.
    if (!input.supersedes)
      for (const fact of this.#facts.values()) {
        if (
          fact.status === "active" &&
          fact.type === input.type &&
          similarity(fact.text, input.text) >= DEDUP_THRESHOLD
        ) {
          this.#save({
            ...fact,
            usefulness: fact.usefulness + 1,
            confidence: Math.min(1, fact.confidence + 0.05),
            updatedAt: this.#iso(),
          });
          return { id: fact.id, action: "reinforced" };
        }
      }

    const ts = this.#iso();
    const origin = originForScope(input.scope, this.#roots);
    const fact = {
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

    const supersededMissing = input.supersedes ? this.#retire(input.supersedes, ts) : undefined;
    this.#save(fact);
    return {
      id: fact.id,
      action: "created",
      ...(supersededMissing !== undefined ? { supersededMissing } : {}),
    };
  }

  /**
   * recall({ query?, limit = 5, mode? }) -> { memories: [{ fact, score }], episodes? }
   * mode "prime" (no query) is the session warm set: the top facts and the most recent episodes.
   */
  recall(input) {
    this.#ensureFresh();
    const limit = input.limit ?? 5;
    if (input.mode === "prime") {
      const memories = this.activeFacts()
        .map((fact) => ({ fact, score: recallScore(fact, 1) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      const episodes = [...this.#episodes.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
      return { memories, episodes };
    }
    if (!input.query) return { memories: [] };
    const scored = [];
    for (const hit of this.#index.search(input.query, limit * 4)) {
      const fact = this.#facts.get(hit.id);
      if (fact && fact.status === "active")
        scored.push({ fact, score: recallScore(fact, hit.relevance) });
    }
    scored.sort((a, b) => b.score - a.score);
    return { memories: scored.slice(0, limit) };
  }

  /** search(query, limit = 10) -> [{ id, snippet, type, scope }]: the active facts the index matches. */
  search(query, limit = 10) {
    this.#ensureFresh();
    return this.#index.search(query, limit).flatMap((hit) => {
      const f = this.#facts.get(hit.id);
      return f && f.status === "active"
        ? [{ id: f.id, snippet: f.text.slice(0, 200), type: f.type, scope: f.scope }]
        : [];
    });
  }

  /**
   * update(id, { text?, tags?, type?, scope?, confidence?, status?: "active" | "superseded",
   * supersedes? }) -> outcome; supersededMissing as on write().
   */
  update(id, patch) {
    if (id.trim() === "") return blankId();
    const fact = this.#facts.get(id);
    if (!fact) return { ok: false, reason: "not-found", id };
    const changes = this.#clean(patch);
    // The file lives in the root its id names; a scope that belongs in the other root would leave a
    // user fact in the project's store (or the reverse) under the wrong id.
    // The fact's own scope is never a move, even if its id's root differs (a repo fact written
    // before the project had a root).
    if (
      changes.scope !== undefined &&
      changes.scope !== fact.scope &&
      originForScope(changes.scope, this.#roots) !== originOf(id)
    )
      return badInput(
        "scope",
        "a scope stored in the fact's own root; to move it between the project and global roots, write it anew with supersedes",
      );
    if (changes.supersedes === id) return badInput("supersedes", "the id of another fact");
    // Only an active fact can be patched active. Un-archiving is recover()'s job (it also clears the
    // tombstone and the strike counter); supersession is terminal.
    if (changes.status === "active" && fact.status !== "active")
      return { ok: false, reason: "invalid-state", id, status: fact.status };
    const ts = this.#iso();
    const supersededMissing = changes.supersedes ? this.#retire(changes.supersedes, ts) : undefined;
    this.#save({ ...fact, ...changes, updatedAt: ts });
    return { ok: true, id, ...(supersededMissing !== undefined ? { supersededMissing } : {}) };
  }

  /**
   * feedback({ recalled, used, outcome, recallMisses? }) -> { applied, skipped: [{ id, reason }], requested }
   * (feedback.mjs has the rules). All ids invalid (nothing applied, some requested) is the adapter's
   * not-found.
   */
  feedback(input) {
    return applyFeedback(this.#facts, input, this.#iso(), (fact) => this.#save(fact));
  }

  /** stats() -> { facts, episodes, active, superseded, archived, undistilled, byType, readErrors } */
  stats() {
    this.#ensureFresh();
    let active = 0;
    let superseded = 0;
    let archived = 0;
    const byType = {};
    for (const f of this.#facts.values()) {
      if (f.status === "active") active++;
      else if (f.status === "archived") archived++;
      else superseded++;
      byType[f.type] = (byType[f.type] ?? 0) + 1;
    }
    let undistilled = 0;
    for (const e of this.#episodes.values()) if (!e.distilled) undistilled++;
    return {
      facts: this.#facts.size,
      episodes: this.#episodes.size,
      active,
      superseded,
      archived,
      undistilled,
      byType,
      readErrors: this.#readErrors,
    };
  }

  /**
   * episodeWrite({ task, shape, outcome, retries?, lesson?, usedMemories?, recallMisses?, repoId? })
   *   -> { id }
   */
  episodeWrite(input) {
    const origin = this.#roots.project ? "p" : "g";
    const episode = {
      id: newId(origin),
      task: input.task,
      shape: input.shape,
      outcome: input.outcome,
      distilled: false,
      createdAt: this.#iso(),
      ...(input.retries !== undefined ? { retries: input.retries } : {}),
      ...(input.lesson !== undefined ? { lesson: input.lesson } : {}),
      ...(input.usedMemories ? { usedMemories: input.usedMemories } : {}),
      ...(input.recallMisses ? { recallMisses: input.recallMisses } : {}),
      ...(input.repoId !== undefined ? { repoId: input.repoId } : {}),
    };
    this.#store.writeEpisode(origin, episode);
    this.#episodes.set(episode.id, episode);
    this.#stale();
    return { id: episode.id };
  }

  undistilledEpisodes() {
    return [...this.#episodes.values()].filter((e) => !e.distilled);
  }

  /** stampDistilled(ids) -> { applied, skipped: [{ id, reason }], requested } */
  stampDistilled(ids) {
    const applied = [];
    const skipped = [];
    for (const id of ids) {
      const e = this.#episodes.get(id);
      if (!e) {
        skipped.push({ id, reason: "no such episode exists" });
        continue;
      }
      if (e.distilled) {
        skipped.push({ id, reason: "episode is already distilled" });
        continue;
      }
      const next = { ...e, distilled: true };
      this.#store.writeEpisode(originOf(e.id), next);
      this.#episodes.set(id, next);
      this.#stale();
      applied.push(id);
    }
    return { applied, skipped, requested: ids.length };
  }

  activeFacts() {
    return [...this.#facts.values()].filter((f) => f.status === "active");
  }

  /**
   * Restore a tombstoned (archived) fact back to active — the recover side of auto-decay. Clears the
   * strike counter and tombstone; the reload that follows every write puts it back in the text index.
   * Splits failure: id absent -> not-found; present but not archived -> invalid-state (carrying the
   * actual status so the adapter can distinguish the two for the caller).
   */
  recover(id) {
    if (id.trim() === "") return blankId();
    const fact = this.#facts.get(id);
    if (!fact) return { ok: false, reason: "not-found", id };
    if (fact.status !== "archived")
      return { ok: false, reason: "invalid-state", id, status: fact.status };
    const { archivedAt: _tombstone, ...live } = fact;
    this.#save({ ...live, status: "active", decay: 0, updatedAt: this.#iso() });
    return { ok: true, id };
  }

  /** Manual-removal override: delete a memory from the live store and disk by id. */
  forget(id) {
    if (id.trim() === "") return blankId();
    if (this.#facts.delete(id)) {
      this.#store.deleteFact(originOf(id), id);
      this.#stale();
      return { ok: true, id, kind: "fact" };
    }
    if (this.#episodes.delete(id)) {
      this.#store.deleteEpisode(originOf(id), id);
      this.#stale();
      return { ok: true, id, kind: "episode" };
    }
    return { ok: false, reason: "not-found", id };
  }

  /**
   * Manual force-rebuild: re-read the file store (truth) into the maps/index regardless of the freshness
   * signature, and report the fact/episode counts before and after. The escape hatch when another
   * process wrote memories this session can't see. `rebuilt` reflects whether a count moved (the
   * rebuild itself always runs — that is the "force" semantics).
   * resync() -> { rebuilt, before: { facts, episodes }, after: { facts, episodes } }
   */
  resync() {
    // Read `before` from the CURRENT maps first — load() clears them before repopulating.
    const before = { facts: this.#facts.size, episodes: this.#episodes.size };
    this.load();
    const after = { facts: this.#facts.size, episodes: this.#episodes.size };
    return {
      rebuilt: before.facts !== after.facts || before.episodes !== after.episodes,
      before,
      after,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────
  /**
   * Cheap freshness guard: re-probe the store's stat-signature and, only on mismatch (or before the
   * first load), rebuild via the idempotent load(). When nothing changed on disk the fresh path is just
   * a tuple compare — no rebuild. Runs at the top of every disk-truth-dependent read.
   */
  #ensureFresh() {
    const sig = this.#store.signature();
    if (
      this.#signature === null ||
      sig.count !== this.#signature.count ||
      sig.maxMtimeMs !== this.#signature.maxMtimeMs
    ) {
      this.load(); // re-captures the signature
    }
  }

  /** Mark the loaded view stale after one of this service's own writes: the next read reloads it. */
  #stale() {
    this.#signature = null;
  }

  /** Write a fact to the file store and the map. The index catches up on the reload #stale() forces. */
  #save(fact) {
    this.#store.writeFact(originOf(fact.id), fact);
    this.#facts.set(fact.id, fact);
    this.#stale();
  }

  /** Mark `id` superseded, as a `supersedes` link does. Returns `id` when no such fact exists. */
  #retire(id, ts) {
    const old = this.#facts.get(id);
    if (!old) return id;
    this.#save({ ...old, status: "superseded", updatedAt: ts });
    return undefined;
  }

  #body(fact) {
    return [fact.text, fact.why ?? "", (fact.tags ?? []).join(" ")].join(" ").trim();
  }

  #iso() {
    return new Date(this.#now()).toISOString();
  }

  #clean(patch) {
    return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  }
}
