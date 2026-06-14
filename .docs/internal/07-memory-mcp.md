# 07 — Memory MCP: Tool Shapes & Schema

> **Status:** Locked (iteration 1) · **Date:** 2026-06-13 · **Scope:** the buildable interface for
> `@agentry/memory` — the data model, the tool surface, and the priming hook. Turns the memory design
> (02 cognition · 03 flows) into a concrete contract to implement against.
>
> ⚠️ Numeric knobs (recall limit, dedup threshold, `K`, decay rates) are **benchmark-driven** (§6).

---

## 0. Storage recap (from 01 §8 / 02 §6)

**Text files are the source of truth; the SQLite DB is a disposable, `.gitignored` index** rebuilt from
them. Agent is the sole writer; humans read-only. One file per memory · **origin-qualified ULID ids** (no
autoincrement → no merge collisions) · **supersede, not mutate** · two roots (global `~/.agentry` +
project `.agentry/`). The Obsidian/wiki layer is removed.

A write is atomic *inline*: write the memory file **and** update the in-memory index in one operation,
so the index never drifts mid-session. Out-of-band changes (git pull/merge) are absorbed by a
**rebuild-on-session-start** (`files → index`).

> *Implementation note (Phase 1):* the derived index is **in-memory `node:sqlite`/FTS5, rebuilt at
> startup** (no DB file → nothing to gitignore, no temp+swap); FTS5 falls back to a token scan where a
> Node build lacks it (e.g. Node 22).

### On-disk record format

One **Markdown** file per record: `<root>/facts/<slug>-<ulid>.md`, `<root>/episodes/<slug>-<ulid>.md`.
**YAML frontmatter** holds the fields; the **body** holds the prose (a fact's `text`, an episode's
`task`) — human-readable and git-diffable. The `<slug>` (derived from the body) is for readability; the
`<ulid>` is the stable, collision-free identity (one file per id — a stale-slug sibling is removed on
rewrite). Parsed/written with the bundled `yaml` lib. **Same-concept duplication is prevented by
dedup-reinforce at write time, not by the filename.**

```markdown
---
id: p:01KV28YP22JRH8D81GAH0VVQSZ
type: gotcha
scope: repo
confidence: 0.7
usefulness: 0
status: active
tags: [plugin-dev, mcp]
createdAt: 2026-06-14T05:16:29.120Z
why: <rationale>
---

<the memory text — the body>
```

---

## 1. Data model

### Enums

```ts
type Scope  = "user" | "global" | "repo"          // where it applies → routing root
type Status = "active" | "superseded"             // superseded is NEVER recalled
type MemoryType =
  | "gotcha" | "decision" | "preference" | "repo-fact"   // the semantic core
  | "learning" | "gap" | "limitation"                    // the Evolution layer (01 §5)
type Shape  = "one-shot" | "spec-first" | "decompose+verify"   // tolerant of new values
```

Evolution entries = `scope:"global"` + `type ∈ {learning,gap,limitation}` + a `subject`. Evolution is
*not a separate system* — it's memory with a harness subject.

### Fact (semantic memory)

```ts
Fact {
  id:          string        // origin-qualified ULID — "g:01J…" (global) | "p:01J…" (project)
  type:        MemoryType
  scope:       Scope
  text:        string        // the memory
  why?:        string        // rationale (decisions / gotchas)
  tags?:       string[]
  subject?:    string        // evolution only: "agentry" | "claude-code" | <skill/agent>
  confidence:  number        // 0..1 — how true (the "suspect" path lowers it)
  usefulness:  number        // ≥0 — how often it helped (citation-gated)
  status:      Status
  supersedes?: string        // id this replaces
  provenance?: string[]      // source episode/fact ids — the interlink graph
  repoId?:     string        // origin-qualified repo identity (repo scope)
  createdAt; updatedAt
}
```

Each Fact = one file (these fields are its frontmatter); the DB row mirrors it.

### Episode (episodic record — the Journal in store form)

```ts
Episode {
  id:           string
  task:         string
  shape:        Shape
  outcome:      string       // "pass" | "fail" | "partial" + summary
  retries?:     number
  lesson?:      string       // distill seed
  usedMemories?: string[]    // citation signal (02 §4)
  recallMisses?: string[]
  distilled:    boolean      // idempotent FILE field → the v1 "re-appears undistilled" bug can't recur
  repoId?:      string
  createdAt
}
```

### Two-root routing

`repo`-scoped writes → project DB (if present) else global. `user`/`global` → global always. Recall/
search **union across both roots**; `id` origin-prefix (`g:`/`p:`) tells updates which root to hit.

---

## 2. Tool surface (9 tools)

The 8 from doc 03 + **`memory_feedback`** (the sink for the usefulness signal, 02 §4).

### Writes

**`memory_write`** — capture a semantic fact; **dedup-reinforces** internally.
```
in : { type, scope, text, why?, tags?, subject?, repoId?, supersedes?, provenance? }
out: { id, action: "created" | "reinforced", reinforcedId? }
```
If a near-duplicate exists → bump its usefulness/confidence, return `reinforced` (do **not** create a
copy). The write-bar ("will it change a future decision?") is applied by the *caller* (the agent);
episodes are exempt.

**`episode_write`** — record an episode.
```
in : { task, shape, outcome, retries?, lesson?, usedMemories?, recallMisses?, repoId? }
out: { id }
```

**`memory_update`** — reflect: patch a fact (incl. supersede).
```
in : { id, patch: { text?, tags?, type?, scope?, confidence?, status?, supersedes? } }
out: { id, updated: true }
```

**`memory_feedback`** — apply the citation + outcome table (02 §4).
```
in : { recalled: string[], used: string[], outcome: "pass"|"fail", recallMisses?: string[] }
out: { updated: number }
```
`used + pass` → +usefulness/+confidence · `recalled, not used` → decay tick · `used + fail-in-domain` →
**suspect**: lower confidence · `recallMiss` → +relevance weight.

### Reads

**`memory_recall`** — few, ranked, scoped, **never superseded**. Dual mode.
```
in : { query?, scope?, repoId?, limit?=~5, mode?: "task" | "prime" }
out: { memories: ScoredFact[], episodes?: Episode[] }   // each with id + {relevance,confidence,usefulness}
```
`mode:"prime"` (no query, session start) → warm set: recent relevant episodes + top repo semantic +
available-capabilities note. `score = relevance × confidence × usefulness`.

**`memory_search`** — broad FTS, highlighted snippets, larger set (exploration when recall's few aren't enough).
```
in : { query, scope?, repoId?, limit? }
out: { results: [{ id, snippet, type, scope }] }
```

**`memory_stats`** — counts + undistilled debt (drives the reflect nudge); optional per-root + reindex.
```
in : { byRoot?, reindex? }
out: { facts, episodes, undistilled, superseded, byType, byRoot? }
```

### Flow tools

**`memory_distill`** — two-mode (03).
```
list : { mode:"list", repoId? }            → { clusters: [{ episodes, draftFacts }] }
stamp: { mode:"stamp", episodeIds: [...] } → { stamped: number }
```
Distill *proposes* draft facts; the actual fact write goes through `memory_write` (proposal ≠ write).
Stamping sets the idempotent `distilled` file field.

**`memory_consolidate`** — cluster recurring memories, **propose** skill promotions; **never writes a skill**.
```
in : { scope?, repoId?, minRecurrence?(K), minUsefulness? }
out: { proposals: [{ pattern, supportingMemoryIds, draftSkill:{name,description,body}, provenance }] }
record (after human approval): { recordPromotion: { proposalId, skillName } } → writes provenance only
```
Skills modify the user's Claude Code config → **human-gated, always** (03 §3). Consolidate records the
promotion's provenance; it does not install the skill.

---

## 3. The priming hook (SessionStart)

Lives at the **plugin root** (`hooks/`), not in an agent (04 §6 — plugin agents can't embed hooks/MCP).

- Fires on SessionStart; checks `agent_type` → **prime the conductor only**, not workers.
- Calls `memory_recall(mode:"prime")` and injects the warm set as a `systemMessage`: recent episodes
  (continue-context) · top repo semantic · the **available-capabilities** line (detected MCPs/tools, 05
  §3b) · the **undistilled-episode debt** count ("N undistilled — run reflect to compound?").
- Bounded by construction → recall is reliable, the model can't forget what's injected.

---

## 4. Package layout (`mcp/` → `@agentry/memory`)

Reuse v1's clean architecture (its one solid part), adapted to text-as-truth:

```
mcp/src/
  domain/        # pure types (Fact, Episode, enums) + MemoryStore logic — no I/O, unit-tested
  application/   # services: write/recall/distill/consolidate/feedback orchestration
  persistence/
    file-store/  # one-file-per-memory read/write (the SOURCE OF TRUTH)
    db-index/    # node:sqlite + FTS5 derived index; rebuild(files)→DB (atomic temp+swap)
  resolution/    # two-root resolution (global + project), id origin-qualification
  tools/         # one thin adapter per tool (description + zod input shape + handler)
  index.ts       # stdio server: resolve roots → rebuild index → register 9 tools → connect
```

- **Node ≥ 24** (`node:sqlite` flag-free), **zero native deps**, **`dist/index.js` committed** (zero-install).
- A write = `file-store.write()` + `db-index.upsert()` in one op. Start = `db-index.rebuild(file-store)`.
- `MemoryStore` is free of MCP/FS concerns; tools are thin adapters (logic in code, not prose — 01 P6).

---

## 5. The usefulness loop, end-to-end (how the tools compose)

```
prime ─ memory_recall(mode:prime) ─▶ conductor injects warm set (with ids)
task  ─ agent uses some ─▶ reports used_memories
close ─ episode_write({usedMemories, recallMisses, outcome})
      ─ memory_feedback({recalled, used, outcome, recallMisses})  ─▶ usefulness/confidence/decay updated
reflect ─ memory_distill(list) ─▶ draft facts ─ memory_write(...) ─▶ semantic grows
        ─ memory_consolidate ─▶ skill proposal ─▶ [HUMAN GATE] ─▶ recordPromotion
```

---

## 6. Open / to-benchmark (knobs)

| Knob | Iteration-1 default | Tool |
| :--- | :--- | :--- |
| recall `limit` | ~5 | `memory_recall` |
| dedup similarity threshold | TBD | `memory_write` (reinforce vs create) |
| `K` recurrence / `minUsefulness` | TBD | `memory_consolidate` |
| decay rate · suspect penalty | TBD | `memory_feedback` |
| score weighting | equal `r×c×u` | `memory_recall` |

---

## 7. Closed vs deferred

**Closed:** the data model (Fact · Episode · enums) · origin-qualified ULID ids + two-root routing · the
**9-tool surface** with in/out shapes · `memory_feedback` (the usefulness sink) · the SessionStart
priming hook · the clean-arch package layout (text-as-truth + derived `node:sqlite` index) · the
end-to-end usefulness loop.

**Deferred (next, per build order):** the **Workbench** (V2) · **plugin manifest/layout assembly**
(`.claude-plugin/`, `.mcp.json`, hooks wiring, commands/nodes) · then **implement** `@agentry/memory` +
the **benchmark harness** and run the first calibration pass.

---

_Signed-off (iteration 1): the memory MCP is specified to the tool-shape level — 9 tools, a text-as-truth
store with a derived index, and a priming hook that makes recall reliable by construction._
