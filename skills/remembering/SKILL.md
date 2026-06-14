---
name: remembering
description: This skill should be used when running Agentry's memory flows — curating the store (reflect), graduating a run's episodes into durable semantic facts with provenance (distill), judging whether a recurring pattern has earned a human-gated skill proposal (consolidate), and keeping recall clean (few, ranked, scoped, never-superseded). Loaded for memory-grooming and end-of-run curation work, not for in-task recall alone.
version: 0.1.0
---

# Remembering

The discipline of **durable memory**: keep the store small, true, and useful so it surfaces the *few things that change the next action* — never a firehose. The craft is selectivity, not accumulation. A clean store that warms run #2 is the goal; a bloated one that drowns recall is the failure.

## The one rule under everything: the write-bar

Write a **semantic** memory only if it is **durable, reusable, non-derivable, and will change a future decision.** If it won't alter a future action, it is a Journal line, not a memory. This is the gate that stops hoarding — apply it to *every* fact before writing.

**Episodes are exempt.** The episodic layer (the Journals) is the cheap firehose: written liberally, one per run, recalled narrowly (recent + relevant). Write episodes freely; mine facts from them rarely. Separating the cheap firehose from the rare gold is what makes memory responsible without a human curating it.

## The flows (run in this order; stop early when nothing is earned)

### reflect — curate
- Resolve contradictions; **supersede** stale facts (mark + link to the replacement — never edit in place, never delete); confirm low-confidence claims.
- Then hand the run's episodes to distill.

### distill — episodes → facts (the differentiator)
1. **Cluster** recent undistilled episodes by topic.
2. For each recurring lesson, apply the **write-bar**. Below the bar → drop it.
3. Above the bar → **dedup-reinforce or write**: search for a similar fact first; if one exists, **bump its confidence/usefulness** instead of writing a twin. Only write a new fact when none exists.
4. Every fact **cites its source episodes** (provenance); **confidence ∝ support count** (more episodes backing it → higher confidence).
5. **Stamp** each source episode `distilled: true` as a field in its text file — so distill is idempotent and episodes can't reappear as undistilled.

### consolidate — facts → skill proposal (HUMAN-GATED)
- Fires only when a pattern is **procedural-shaped** (a how-to, not a one-off fact) **and** recurs across **K distinct tasks above the usefulness floor**.
- Cluster the recurring facts → draft a SKILL.md (or a section for an existing skill) with **rationale + provenance** (the source facts/episodes that motivated it).
- **Propose only. Never install.** A skill is installed configuration in the user's Claude Code — a different trust class than data. Hand the proposal up for human approval; only after approval is the file written.
- A recurring gotcha that is *not* a how-to stays a high-confidence fact (maybe a checklist item) — do not promote it.

## Autonomy = trust tiers

Gating scales with what the write touches:

- **Data ops** (episodic capture, distill, dedup-reinforce, decay/supersede, usefulness updates) → **auto, no human.**
- **New semantic claims** (gotchas, decisions, prefs, repo-facts) → **auto + the write-bar** (decay cleans any noise).
- **Skill promotion** (consolidate) → **human-approved, always.** Never silently modify the user's setup.

## Provenance everywhere

Every graduated memory links to its source: **fact → source episodes**, **skill → source facts.** This is the interlink graph, and it is the trail the suspect/decay logic follows to assign blame. A fact with no provenance, or a skill proposal with no source facts, is not done.

## The usefulness signal (citation-primary, outcome-gated)

A memory earns its keep when it **changes an action and the work passes.** Score on three orthogonal axes: `relevance × confidence × usefulness`. Apply these effects from the run's `used_memories` / `recall_misses`:

| Situation | Effect |
| :--- | :--- |
| Cited "changed my action" **+ work passed** | **+usefulness, +confidence** |
| Recalled, **not cited** | neutral → counts toward "recalled N, used 0" → **decay** |
| Cited **but work failed in its domain** | **suspect** — no boost; **lower confidence** |
| Re-derived but **not recalled** (recall-miss) | boost its **relevance weight** |
| Human keep/remove | **hard override** |

The **suspect** row is the safety check — it demotes a *misleading* memory instead of compounding it. A high-confidence but never-useful fact still sinks: true-but-irrelevant clutter doesn't survive.

## Recall hygiene

Recall returns **few** (≈3–7), **ranked** by `relevance × confidence × usefulness`, **scoped** to the right tier (project vs global), and **never superseded** — exclude superseded facts by construction so they can't win a slot. Scope routing holds in both directions: project episodes graduate to project facts; global stays global.

## Anti-patterns (refuse these)

- **Hoarding / over-writing** — a fact that won't change a future decision belongs in the Journal, not the store.
- **Duplicating** — writing a near-twin instead of dedup-reinforcing the existing fact.
- **Mutating instead of superseding** — editing or deleting a stale fact in place, breaking the recoverable chain.
- **Recalling superseded facts** — surfacing a replaced fact; recall excludes them by construction.
- **Provenance-free graduation** — a fact with no source episodes, or a skill with no source facts.
- **Auto-installing a skill** — writing a SKILL.md without explicit human approval.

## Capability-first tools

The job is durable memory; prefer the memory MCP tools if present, discovered on demand:
`episode_write` (capture) · `memory_write` (applies write-bar + dedup-reinforce) · `memory_recall` (few/ranked/scoped/never-superseded) · `memory_search` (broad FTS) · `memory_update` (supersede/patch/confidence) · `memory_distill` (list undistilled drafts / stamp distilled) · `memory_consolidate` (cluster + propose) · `memory_stats` (health / undistilled debt). If the memory MCP is absent, say so and degrade gracefully — never fake a write.

## Additional resources

### Reference files
- **`references/curation-and-provenance.md`** — the full mechanics: dedup-reinforce vs write, supersede chains, distill clustering, the human-gated consolidate workflow, scope routing, and the usefulness/decay update procedure end to end.
