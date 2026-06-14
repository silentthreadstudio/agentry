# 02 — Memory: The Moat

> **Status:** Locked (iteration 1) · **Date:** 2026-06-13 · **Scope:** the cognitive design of memory —
> layers, write/recall/decay discipline, and the usefulness signal. Storage is settled in
> [01 §8](./01-content-generation.md); flows + the MCP tool surface are deferred (§9).
>
> ⚠️ **This will not be right the first time.** The *structure* below is locked; the *parameters*
> (recall count, decay thresholds, scoring weights, citation reliability) are explicitly tuning knobs
> to be set by **benchmark**, not by guessing now. §8 lists what we measure. Sign, ship, measure, tune.

---

## 0. Governing principle

> Memory's job is **not to remember everything** — it's to surface the *few things that change the next
> action.* v1 drowned because it treated all memory as one high-recall bucket and wrote to it freely.
> The whole design below exists to make memory **responsible, fast, and useful** by construction.

---

## 1. Layers — tier writing AND recall differently (this is what dissolves "too much context")

| Layer | Volume | Write bar | Recalled by | Solves |
| :--- | :--- | :--- | :--- | :--- |
| **Working** | per-task | — (it's the live context + work docs) | n/a | the task in flight |
| **Episodic** (what happened — *the Journals*) | high (1/run) | **low** — write liberally | **recency × relevance**, recent only | **amnesia / continue-context** |
| **Semantic** (gotchas, decisions, prefs, repo-facts) | low (curated) | **high** — must recur & change a decision | **relevance × confidence × usefulness** | not repeating mistakes |
| **Procedural** (skills) | tiny | promoted from repeated patterns | injected by task type | compounding craft |

**Key move:** episodes are a *firehose* written cheaply and recalled *narrowly* (recent + relevant);
semantic is *gold* written rarely and recalled by value. Separating them is what makes memory
responsible without a human curating it. The **Journals** (doc 01) *are* the episodic record — docs and
memory are the same system here.

---

## 2. The three selectivity gates

- **Write gate** — only write semantic memory that is *durable, reusable, non-derivable, and will change
  a future decision.* If it won't alter a future action, it's a Journal line, not a memory. Episodes are
  exempt (the firehose).
- **Recall gate** — return **few** (≈3–7, *tuning knob*), scoped, ranked, **never superseded**, bounded
  *by construction* so injecting it can't pollute context. Recall is **task-specific and disciplined** —
  the conductor recalls *for the task at hand* (relevant, deliberate). The SessionStart primer is only a
  **minimal nudge** (counts + a continue-context pointer, hard-capped), **not** a force-fed warm set —
  auto-injecting generic memory at startup (no task yet) is low-relevance pollution (doc 07 §3).
- **Decay gate** — a memory never recalled, or recalled-and-ignored, **loses rank and self-archives**
  (tombstoned, recoverable — not deleted). The active set stays small on its own. This is the valve v1
  lacked.

---

## 3. Write model — auto-write + auto-prune (LOCKED)

Writing is **fully automatic, no confirmation prompts** (low friction, the user's call). What makes that
*safe* — and what v1 missed — is that **pruning is automatic too.** Responsibility lives in the system,
not the user's diligence.

Four mechanisms:
1. **Write-time bar (free, no human).** The writing agent applies the write gate (§2) before writing a
   semantic memory. One sentence in the agent brief; zero friction.
2. **Dedup-reinforce, not duplicate.** Before writing, check for a similar memory. If one exists, **bump
   its confidence/usefulness** instead of creating a duplicate. Biggest cleanliness win under auto-write
   (v1 duplicated relentlessly).
3. **Usefulness-weighted recall.** Recalled-and-ignored sinks; recalled-and-helped floats (§4).
4. **Auto-decay / archive.** §2 decay gate.

**Manual removal exists as an *override*, not the primary defense.** Rationale: a bad write is silent and
competes for recall slots immediately; tracing degraded recall back to one memory is high-friction and
reactive — so the system must self-clean, and the human stays a backstop. The user is *in control*
(can override) without becoming a janitor.

---

## 4. Usefulness signal — citation-primary, outcome-gated (LOCKED)

You can't reliably infer "helped" from outcome alone (many memories, one fuzzy result). So the primary
signal is **explicit**: the agent reports which recalled memories *changed its action*.

```
used_memories: [g:37, p:12]   # in the agent's output / Journal frontmatter
```

Symmetric with the write bar: **a memory earns its keep when it changes an action — and the agent reports
exactly when that happens.** Then **gate on outcome** (verify/journal already exist):

| Situation | Effect |
| :--- | :--- |
| Cited "changed my action" **+ work passed** | **+usefulness, +confidence** |
| Recalled, **not cited** | neutral → counts toward "recalled N, used 0" → **decay** |
| Cited **but work failed in its domain** | **suspect** — no boost; **lower confidence** (stale/wrong) |
| Re-derived something in store but **not recalled** | **recall-miss** → boost its *relevance weight* |
| Human keep/remove (Workbench/chat) | **hard override** |

The **suspect** row is the safety check: it's how a *misleading* memory loses confidence instead of
compounding a lie.

**Captured at the journal/verify step** — extend Journal frontmatter with `used_memories` +
`recall_misses`. No new machinery; the docs↔memory bridge carries it.

**Three orthogonal axes** (v1 conflated them): `score = relevance × confidence × usefulness`
- **Relevance** — matches *this* task? (transient, per-recall)
- **Confidence** — is it *true*? (the suspect path lowers it)
- **Usefulness** — has it *helped before*? (what this signal feeds)

Payoff: a high-confidence, **never-useful** fact still sinks — true-but-irrelevant clutter doesn't
survive. Exactly the "don't drown" property.

**Caveat (accepted):** citation is imperfect (agents can be lazy/spurious) but **self-correcting** under
outcome-gating + decay. A weak background prior ("present-in-successes vs absent-in-failures") may nudge
the score over volume — **never** as primary.

---

## 5. Continue-context — the amnesia cure

The "talk about 15 days ago / continue where we left off" capability **is** the episodic layer done
right: when the conductor recalls **for a task**, recent Journals (ranked recency × relevance)
reconstruct the working set. The primer may surface a one-line *"last worked on…"* pointer, but the
real continuity comes from **task-specific recall**, not a generic startup dump. Not "remember
everything" — *recall the few things that matter for what you're doing now.*

---

## 6. Storage (reference)

Per [01 §8](./01-content-generation.md): **text files = truth, SQLite DB = disposable `.gitignored`
index**, one file per memory, **ULID/content ids** (no autoincrement → no merge collisions), **supersede
not mutate**, atomic **rebuild-on-session-start**, two tiers (global `~/.agentry` + project `.agentry/`),
no Obsidian/wiki layer.

---

## 7. Open / to-benchmark (tuning knobs — set by measurement, not guess)

| Knob | Iteration-1 default | What we measure |
| :--- | :--- | :--- |
| Recall count | 3–7 | recall precision vs context cost; does N help or pollute? |
| Decay threshold | recalled-0-in-window → archive | false-archive rate (did we drop something useful?) |
| Scoring weights | `relevance × confidence × usefulness` (equal) | which weighting actually surfaces the helpful memory |
| Citation reliability | trust agent `used_memories` | how often agents cite honestly vs miss/spurious |
| Passive-prior weight | ~0 (off) | does outcome-correlation add signal or noise? |
| Write-bar precision | "changes a future decision" | noise rate — % of writes never recalled |
| Suspect penalty | lower confidence on cited-but-failed | does it correctly demote misleading memories? |

**The north-star test (the moat claim):** the *second* time Agentry does similar work it is faster/better
because the store is warm. If the benchmark can't show that, the design is wrong — that's the regression
test, defined up front so we can't move the goalposts.

---

## 8. Closed vs deferred

**Closed:** the governing principle · the four layers + tiered write/recall · the three gates ·
auto-write + auto-prune · the usefulness signal (citation-primary, outcome-gated, three axes) ·
continue-context via episodic priming · storage (ref).

**Deferred (next):** the **flows** in detail — `reflect` (curate), `distill` (episodic→semantic),
`consolidate` (semantic→procedural/skill promotion criteria) · the **MCP tool surface** (concrete tools
+ shapes) · the semantic **type enum** · the **session-start priming** mechanism (the hook) · scope-
routing detail (what lands global vs project).

---

_Signed-off (iteration 1): memory structure is locked; parameters are benchmark-driven. Next: the flows
or the Workbench — your call._
