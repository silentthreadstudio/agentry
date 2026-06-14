# 03 — Memory Flows: The Graduation Pipeline

> **Status:** Locked (iteration 1) · **Date:** 2026-06-13 · **Scope:** how a run becomes durable
> knowledge and eventually craft — the flows *between* the layers defined in
> [02-memory.md](./02-memory.md). Builds on its layers, gates, write model, and usefulness signal.
>
> ⚠️ Structure locked; **thresholds (`N`, `K`, usefulness floor) are benchmark-driven** (§5).

---

## 0. The pipeline

```
run ──capture──▶ episodic (Journal, auto)  +  semantic (gotchas, auto + write-bar)
                      │
                  reflect ── curate: supersede stale, resolve contradictions
                      │
                  distill ──▶ episodic → semantic    (extract durable facts, with provenance)
                      │
              consolidate ──▶ semantic → procedural (skills)   [HUMAN-GATED]
                      │
        session start ──prime──▶ working  (recent episodes + top semantic + skills)
```

The Journals (doc 01) are the episodic record; distill is the step that turns *what happened* into
*what's durably true*; consolidate turns *recurring truth* into *craft.* prime warm-starts the next
session so recall is reliable by construction.

---

## 1. The flows

### `capture` — working → episodic + semantic (auto)
Per run: the Journal is written (episodic, always); earned gotchas/decisions are written (semantic,
auto + the §2 write-bar). The entry point; covered in [02 §3](./02-memory.md).

### `reflect` — curate (semi-auto)
- **Trigger:** conductor *offers* it after non-trivial work; also a manual command.
- **Does:** resolve contradictions; **supersede** stale facts (mark + link, never delete); confirm
  low-confidence claims; then hand the run's episodes to `distill`.
- **Autonomy:** corrective writes follow the locked auto-write rules.

### `distill` — episodic → semantic (auto · the differentiator)
- **Trigger:** by `reflect`, or auto-prompted at a threshold (`N` undistilled episodes).
- **Mechanics:** cluster recent episodes by topic → extract recurring lessons → write semantic facts.
  Each fact **cites its source episodes** (provenance); **confidence ∝ support count**;
  **dedup-reinforces** against existing facts instead of duplicating.
- **Stamping:** episodes get `distilled: true` as a **field in the text file** (text-as-truth) → the v1
  "episodes re-appear as undistilled" DB-persistence quirk **cannot recur** (idempotent by construction).
- **Autonomy:** **auto-fire with the write-bar** — it graduates already-captured data; bar + dedup +
  decay keep it clean. Consistent with the locked auto-write decision.

### `consolidate` — semantic → procedural / skills (HUMAN-GATED)
- **Trigger:** a pattern recurs across **`K` distinct tasks** above a **usefulness floor**, and is
  *procedural-shaped* (a how-to, not a one-off fact); also manual.
- **Mechanics:** cluster the recurring memories → **propose** a SKILL.md (or a section in an existing
  skill) with rationale + provenance (the facts/episodes that motivated it).
- **Autonomy:** **always human-approved. Never auto-writes a skill.** Rationale: *a skill is installed
  configuration in the user's Claude Code* — a different trust class than data. The system can auto-clean
  a bad fact via decay; it must not silently modify the user's setup. After approval the file is written
  (reload-gated in Claude Code).
- A recurring gotcha that *isn't* a how-to stays a high-confidence fact (maybe a checklist item), not a
  new skill.

### `prime` — store → working (session-start hook)
Injects the **bounded** warm set: recent relevant episodes (continue-context) + top semantic for this
repo + applicable skills. Reliable-by-construction — the model can't forget what the harness already
loaded.

---

## 2. Cross-cutting (two close named v1 gaps)

- **Provenance everywhere** — every graduated memory links to its source (fact→episodes, skill→facts).
  This *is* the Karpathy interlink graph; it's also what lets the suspect/decay logic trace blame.
- **Skills get the usefulness signal too** — procedural participates: tasks cite `used_skills`,
  consolidate weighs usefulness, unused skills get flagged. (v1 tracked fact-usefulness but **not**
  skill-usefulness — fixed here.)
- **Scope routing** — flows respect origin: project episodes → project facts; global stays global
  ("always use PNPM" never leaks into a repo store).
- **Idempotent stamping** — `distilled` (and similar) are file fields, not DB-only state → no re-run loops.

---

## 3. Autonomy = trust tiers (the governing rule)

> **Gating scales with what the write touches.** Data the system can auto-clean is automatic; installed
> configuration is gated. (The v1 "tier by risk" lesson, stated as a principle.)

| Tier | Operations | Gate |
| :--- | :--- | :--- |
| **Data ops** | episodic capture, distill, dedup-reinforce, decay/supersede, usefulness updates | **auto, no human** |
| **New claims** | semantic gotchas / decisions / prefs | **auto + write-bar** (decay cleans noise) |
| **Installed config** | skill promotion (consolidate) | **human-approved, always** |

---

## 4. Implied MCP tool surface (shapes deferred)

The flows define the tool set; concrete params/shapes are specced when the MCP is built.

| Tool | Flow | Kind |
| :--- | :--- | :--- |
| `episode_write` | capture (episodic) | write |
| `memory_write` | capture (semantic) — applies write-bar + dedup-reinforce | write |
| `memory_recall` | prime + in-task recall — few, ranked, scoped, never-superseded | read |
| `memory_search` | broad exploration (FTS) | read |
| `memory_update` | reflect — supersede / patch / confidence | write |
| `memory_distill` | distill — list undistilled w/ drafts, or stamp distilled | write |
| `memory_consolidate` | consolidate — cluster + **propose** promotions (never installs) | read/write |
| `memory_stats` | health / counts / undistilled debt (drives the threshold prompt) | read |

---

## 5. Open / to-benchmark

| Knob | Iteration-1 default | What we measure |
| :--- | :--- | :--- |
| `N` — undistilled threshold to prompt distill | TBD | distill cadence vs episode backlog |
| `K` — distinct-task recurrence for skill proposal | TBD | proposal precision (are proposed skills worth it?) |
| usefulness floor for promotion | TBD | do high-usefulness patterns make better skills? |
| distill cluster granularity | topic similarity | over/under-merging of lessons into facts |

**North-star (unchanged):** warm-store run #2 beats run #1. The flows are *how* the store gets warm.

---

## 6. Closed vs deferred

**Closed:** the pipeline · all five flows (mechanics · trigger · autonomy) · the trust-tier rule ·
provenance + skill-usefulness + scope routing + idempotent stamping · the implied tool surface.

**Deferred (next):** concrete **MCP tool shapes/params** (when we build `@agentry/memory`) · the semantic
**type enum** · the **session-start priming hook** implementation · the routing/right-sizing **brain** ·
the **agents & skills roster** · the **Workbench**.

---

_Signed-off (iteration 1): memory flows are locked; thresholds are benchmark-driven. The memory moat —
storage (01 §8), cognition (02), and flows (03) — is now fully specified at the design level._
