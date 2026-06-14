# 05 — The Roster: Dev Team + Product Team

> **Status:** Locked (iteration 1) · **Date:** 2026-06-13 · **Scope:** the specialists Agentry ships —
> their roles, their craft skills, the agent↔skill pairing, and how they adapt to the user's environment.
> "Well-prepared, benchmarked specialists" made concrete.
>
> Depends on: the brain (04 — conductor, guide-don't-cage), content (01), memory (02–03).

---

## 0. The two rules every specialist obeys

1. **Role lives in the agent; craft lives in the skill.** An agent = identity + operating discipline +
   I/O contract; its craft is a **preloaded skill** (`skills:` frontmatter, confirmed by the doc sweep).
   The role is Agentry's; the skill is generic + agentskills.io-portable. **The quality of the skills
   *is* the product** — they make the same model perform like a senior.
2. **Capability-first, environment-adaptive** (see §3). No tool allowlists; every specialist uses
   *whatever the user brings* and degrades gracefully when it's absent.

The conductor (main session, doc 04) is **not** in the roster — it routes, **gates the Spec with the
user**, sequences, and cites precedent. Everything dispatchable goes to a specialist below.

---

## 1. Dev team (6 specialists)

| Agent | Role | Craft skill(s) | Primary output |
| :--- | :--- | :--- | :--- |
| **explorer** | comprehend existing code, read-only | `exploring` | Context map |
| **researcher** | investigate unknowns (web + repo), cited | `researching` | Research (findings + implications) |
| **architect** | structure · decisions · decomposition | `architecting` + `planning` | ADR · Plan (arch map) · Task contracts |
| **implementer** | clean, bounded code | `implementing` (+debugging mode) + `testing` | code + tests |
| **verifier** | prove it wrong (adversarial, *separate from author*) | `reviewing` (+security lens) + `integrating` | Verdict · Assemble result |
| **librarian** | run the memory flows; keep the moat clean | `remembering` | reflect/distill · **proposed** facts & skills |

Notes: **verifier owns both altitudes** — `reviewing` (unit/code) and `integrating` (whole-product
assemble vs the Spec ACs) — and is never the implementer (no self-grading). **librarian** runs the
verbose distill/consolidate in isolated context and *proposes* (facts auto, skills human-gated per 03);
the conductor gates with the user. Modes fold into skills (debugging→`implementing`, security→`reviewing`),
they don't spawn agents.

---

## 2. Product team (2 specialists)

Earned like everything else — product specialists wake for **product / UI / under-specified / docs**
work, never on a backend one-liner. No product tax on work that doesn't need it.

| Agent | Role | Craft skill(s) | Primary output |
| :--- | :--- | :--- | :--- |
| **product-owner** | the *what & why* — JTBD, scope, prioritization; turns "make X better" into crisp acceptance criteria | `product` + `writing` | Spec (shaped) · docs / release-notes / copy |
| **designer** | UX/UI + product design; the **see-it loop** | `designing` | UI/UX work · design review |

**Spec ownership, reconciled:** the **product-owner shapes the Spec** (the product analysis behind
"done = X") when work is under-specified; the **conductor gates it with the user**; a tiny, clear task
gets a one-line spec from the conductor with no PO. **designer** prevents the v1 "engineers build ugly
UIs" failure — it *sees* the rendered result (render → screenshot → check) before calling UI done.

*(Discretionary call: a dedicated `writer` agent was considered and folded into PO + the `writing` skill —
anti-sprawl. Promote later if content becomes a frequent workstream.)*

---

## 3. Capability-first, environment-adaptive (roster-wide principle)

"Guide-don't-cage" (04) made operational, and the old "degrade gracefully / upgrade sharply" promise
applied to **tools**. Three parts, true for every specialist:

**a) Skills name the *job*, a *preference if present*, and a *fallback*** — never a hard tool name:
```
## Tools (capability-first)
- Navigate code → prefer a semantic code-intel MCP (Serena / LSP) if present → fallback: grep / glob / read.
- External / current info → web search if available; a real investigation → escalate to researcher.
- Render / inspect a UI → a browser MCP (chrome-devtools / claude-in-chrome) if present; else flag UNVERIFIED.
```
Clone with Serena → explorer prefers it automatically (the skill asked for "semantic code-nav," not
"Serena"). Bring nothing → it falls back. No allowlists, no assumptions, no breakage.

**b) The environment is profiled into memory.** `onboard` + the SessionStart primer **detect available
MCPs/tools** and record them as repo-facts ("*this repo has Serena; prefer it*"), primed at session start
as an "available capabilities" line. The environment is just another thing memory knows about the repo.

**c) On-demand discovery.** Claude Code defers MCP tools (the model searches when needed), so a skill can
say "find a code-intel tool" and load it only when it navigates code — zero context cost until used.

> **Agentry adapts to *your* stack; it never requires *ours*.**

---

## 4. Design depth — "design well code," not just code (architect + implementer)

The `architecting` + `implementing` skills carry **deep design references** (`references/`) — the
"senior-level, no 1000-line files" lever:

- **SOLID / SRP**, separation of concerns, **cohesion & coupling**
- module boundaries, **folder/structure conventions**, layering (ports-and-adapters / hexagonal)
- when-to-abstract (**YAGNI ↔ DRY** balance), common patterns
- **anti-patterns explicitly**: god-file, leaky abstraction, premature abstraction

Two judgment rules so it's senior, not dogmatic:
1. **Right-sized** — design depth scales with task size (SOLID on a script is over-engineering). Mirrors
   the brain's floor-and-escalate.
2. **Repo-consistent** — read the Context map + repo-facts and match *existing* conventions, don't impose
   foreign ones.

Output flows structurally: architect → Plan's **Architecture map** → each Task's `contract` is sliced
from it → bounded tasks → no god-files. The whole anti-sprawl chain, grounded in real references.

---

## 5. How the conductor dispatches both teams

One brain, two teams (the teaming is conceptual + a routing signal). Product work wakes the product team;
both are earned via floor-and-escalate (04). A full UI-bearing feature, fully escalated:

```
product-owner (Spec) → designer (UX) → architect (Plan + contracts)
  → implementer ⇄ verifier  (parallel where contracts don't overlap)
  → designer (sees the rendered UI) + verifier (assemble vs ACs)
  → librarian (reflect / distill)
```

A backend one-liner: conductor → implementer. Nothing else wakes. Same roster, different number woken.

---

## 6. The full craft-skill set (12)

`exploring` · `researching` · `architecting` · `planning` · `implementing` (+debugging) · `testing` ·
`reviewing` (+security) · `integrating` · `remembering` · `product` · `designing` · `writing`

Each is a deep, generic, language-agnostic discipline. Modes are folded in (debugging, security); distinct
*crafts* get their own skill. Depth over breadth — "well-prepared" is the depth of these skills.

---

## 7. Open / to-benchmark

| Question | What we measure |
| :--- | :--- |
| Per-specialist lift | does the architect plan better / verifier catch more / designer ship prettier than a plain session? |
| Skill-description triggering | do skills load when they should, without the "describes-the-workflow → model skips body" failure? |
| Capability-fallback | do agents correctly prefer-then-fallback across varied user toolsets? |
| Product-team earn rate | do they wake on product work and stay asleep on backend one-liners? |

North-star (unchanged): beats a plain session on multi-file + under-specified work; warm-store run #2
beats run #1.

---

## 8. Closed vs deferred

**Closed:** the two roster rules · the **dev team** (6) · the **product team** (2) · librarian rename ·
capability-first/environment-adaptive · design-depth references + judgment · the agent↔skill pairing ·
the 12-skill set · cross-team dispatch.

**Deferred (next):** writing the actual **agent definitions + SKILL.md content** (the real work — depth
is everything) · the **MCP tool shapes** + type enum + priming-hook implementation · the **Workbench**
(V2) · the **benchmark harness** · plugin manifest/layout assembly.

---

_Signed-off (iteration 1): the roster is locked — a 6-strong dev team and a 2-strong product team, one
conductor, all capability-first and adaptive to the user's environment. The next work is depth: the
actual skill content._
