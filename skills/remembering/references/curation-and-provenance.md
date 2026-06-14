# Curation & Provenance — depth

Reference for the `remembering` skill. The mechanics behind the flows: how a fact gets written without duplicating, how a stale fact is retired without being lost, how episodes become facts with a traceable source, when a pattern earns a (human-gated) skill, and how the usefulness signal updates the store. Everything here serves one end: a **small, true, useful** store that warms the next run.

## Write vs reinforce — the dedup decision

Auto-write is only safe because pruning is automatic too. The single most important cleanliness move under auto-write is **dedup-reinforce**, because v1 duplicated relentlessly.

Before writing any semantic fact:

1. **Search** the store (the right scope tier) for a similar memory — same claim, same subject, even if worded differently.
2. **If a match exists → reinforce it.** Bump its `confidence` and/or `usefulness`, append the new source episode(s) to its provenance, and refresh its recency. **Do not** create a second record.
3. **If no match exists → write it**, but only after it clears the **write-bar** (durable · reusable · non-derivable · changes a future decision).
4. **If it's below the bar → drop it.** It stays in the Journal as episodic narrative; it does not graduate.

A near-duplicate is worse than no write: it competes for the same recall slot and splits the usefulness signal across two records.

## Supersede chains — retire, never destroy

A fact is never edited in place and never hard-deleted. When a fact becomes stale or wrong:

- Create the **replacement** fact (or identify the existing current one).
- Mark the old fact **superseded** and **link** it to its replacement (`superseded_by`).
- Recall **excludes superseded facts by construction** — they never win a slot again — but the record stays **recoverable** (tombstoned, not deleted).

Why a chain and not a mutation: the link preserves history (you can see what was once believed and why it changed), and it keeps provenance intact for any fact or skill that cited the old record. Mutation silently rewrites the past and breaks those links.

Decay is the softer cousin: a fact **recalled-and-ignored** or **never recalled in the window** loses rank and **self-archives** (tombstoned, recoverable). The active set shrinks on its own — this is the valve v1 lacked. You don't have to manually prune; you let decay do it and reserve supersede for facts that are actively *wrong*, not merely cold.

## Distill — clustering episodes into facts

The differentiator, run on undistilled episodes:

1. **Cluster** by topic (recall-miss boosts and recurring subjects guide the grouping). Watch granularity: over-merging fuses distinct lessons into one mushy fact; under-merging scatters one lesson across many.
2. For each cluster, extract the **recurring lesson** — the thing that was true across multiple episodes, not a one-off incident.
3. Apply the **write-bar** to the lesson. Below it → drop.
4. **Dedup-reinforce or write** (above section). New facts get **confidence ∝ support count** — three episodes backing a lesson is more confident than one.
5. **Stamp** each source episode `distilled: true` **as a field in its text file** (text-as-truth). This makes distill **idempotent**: re-running it can't reprocess already-distilled episodes, so the v1 "episodes reappear as undistilled" DB-persistence quirk cannot recur.

Provenance is non-negotiable here: every fact records **which episodes** it came from. That link is what later lets the suspect/decay logic trace a bad fact back to its source, and what makes the store an interlinked graph rather than a pile.

## Consolidate — the human-gated skill proposal

A skill is **installed configuration in the user's Claude Code**, a strictly higher trust class than a data write. The system may auto-clean a bad fact via decay; it must **never** silently install a skill.

Trigger (all must hold):
- The pattern is **procedural-shaped** — a *how-to*, not a one-off fact.
- It recurs across **K distinct tasks** (not K mentions in one task).
- It clears the **usefulness floor** — the underlying facts have actually helped before.

Workflow:
1. **Cluster** the recurring facts.
2. **Draft** a SKILL.md (or a section to add to an existing skill) with: the procedure, a **rationale**, and **provenance** (the source facts/episodes that motivated it).
3. **Flag it HUMAN-GATED — not installed**, and return it to the conductor to approve with the user.
4. **Only after approval** is the file written (reload-gated in Claude Code).

A recurring gotcha that is **not** a how-to does **not** become a skill — it stays a high-confidence fact, possibly a checklist item. Skill-usefulness is tracked too: tasks cite `used_skills`, consolidate weighs it, and unused skills get flagged (v1 tracked fact-usefulness but not skill-usefulness).

## Usefulness & decay — the update procedure

Captured at the journal/verify step via Journal frontmatter (`used_memories`, `recall_misses`). Three orthogonal axes — `score = relevance × confidence × usefulness`:

- **Relevance** — matches *this* task? (transient, per-recall)
- **Confidence** — is it *true*? (the suspect path lowers it)
- **Usefulness** — has it *helped before*? (what the citation signal feeds)

Apply, per recalled memory:

| Situation | Effect |
| :--- | :--- |
| Cited "changed my action" **+ work passed** | **+usefulness, +confidence** |
| Recalled, **not cited** | neutral → "recalled N, used 0" → **decay** |
| Cited **but work failed in its domain** | **suspect** — no boost; **lower confidence** (stale/wrong) |
| Re-derived but **not recalled** (recall-miss) | boost its **relevance weight** |
| Human keep/remove | **hard override** |

The **suspect** row is the lie-stopper: a *misleading* memory loses confidence instead of compounding. The payoff of the three axes: a high-confidence but **never-useful** fact still sinks — true-but-irrelevant clutter doesn't survive. Citation is imperfect (agents can be lazy or spurious) but **self-correcting** under outcome-gating + decay; a passive prior ("present-in-successes vs absent-in-failures") may nudge the score but **never** as the primary signal.

## Scope routing

Flows respect origin in both directions:
- **Project episodes → project facts.** A repo-specific gotcha stays in `.agentry/`.
- **Global stays global.** A user preference ("always use PNPM") lives in `~/.agentry` and never leaks into one repo's store.

Get the tier right at write time (and at recall time) — a misfiled fact either pollutes a repo with global noise or hides a global truth inside one project.

## Recall — few, ranked, scoped, never-superseded

Recall is bounded **by construction** so injecting it can't pollute context:
- **Few** — ≈3–7 (a tuning knob, set by benchmark).
- **Ranked** — by `relevance × confidence × usefulness`.
- **Scoped** — the correct tier for the task.
- **Never superseded** — superseded/tombstoned records are excluded; they cannot win a slot.
- **Primed at session start** — the warm set (recent relevant episodes + top semantic for the repo + applicable skills) is loaded by the harness so the model can't forget what was already provided.

All numeric thresholds here — recall count, decay window, K, the usefulness floor, scoring weights, support→confidence mapping — are **benchmark-driven tuning knobs**, not values to invent. The *structure* is fixed; the *parameters* are measured.
