# 01 — Content Generation: The Documents Agentry Generates

> **Status:** Locked · **Date:** 2026-06-13 · **Scope:** what Agentry writes to disk for a unit of work.
> Memory internals and the Workbench are **out of scope here** (next docs). This doc defines the
> document *surface*: which docs exist, their structure, how they relate, and where they live.

---

## 0. Governing principles

These are the rules every decision below obeys. They exist because v1 failed on exactly these axes
(over-orchestration, sync bugs, sprawl, under-planning).

1. **Earned, not ceremony.** A doc is generated only if it (a) survives the session, (b) is worth a
   human's review, or (c) feeds memory. Anything else is the ceremony that overthinks a one-liner. The
   default is to write *nothing extra*; depth is escalated by evidence of complexity.
2. **Artifacts are memory in file form.** Docs aren't a separate system from memory — they're the
   working/episodic layers on disk, and the good ones graduate into semantic/procedural memory. A doc
   that feeds no memory layer is cut.
3. **Distinct-but-scaled.** Spec → +Plan → +Tasks as work grows. Same vocabulary at every size; the
   brain emits only what the work earns. One-liner = Spec only.
4. **Markdown is the substrate; types are a registry.** Every doc is typed markdown (YAML frontmatter +
   prose body). The set is *open*: new types (test-plan, security-review, release-notes) are added to a
   registry, never special-cased into the engine.
5. **Truth ownership is explicit.** Work artifacts: the **markdown is truth** (human-editable in the
   Workbench). Memory: the **DB is truth** (read-only in the Workbench, agent-curated only). The two
   never reconcile against each other — that was the v1 bug class.
6. **Logic lives in typed code, not prose.** Commands/agents stay thin (role + intent). Behavior
   (state, locking, ranking, parsing) lives in tested code. No "programs written in prose."

---

## 1. The document set (mapped to the SDLC)

| SDLC phase | Document | Purpose (one line) | Trigger | Truth owner | Feeds memory |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Understand | **Context map** | how this repo is built / where things live | earned · once per repo | markdown | → semantic |
| Understand | **Research** | cited findings (web + codebase) for unknowns | earned · real unknowns | markdown | → semantic |
| Define | **Spec** | the *what* + acceptance criteria ("done = X") | **always** (even 1 line) | markdown | — |
| Decide | **ADR / Decision** | the *why* behind a real fork | earned · genuine fork | markdown → graduates | → semantic |
| Plan | **Plan** | the *how* — approach + the architecture map | earned · multi-step | markdown | — |
| Plan | **Tasks** | discrete units of work + status/deps | earned · multi-step | structured md | → episodic |
| Verify | **Review / Verdict** | did it meet the spec; what broke | earned · when verified | markdown | → episodic + gotchas |
| Close | **Journal** | what actually happened + outcome | earned · non-trivial | markdown | → episodic |
| Meta | **Evolution** | learnings/gaps/limitations of the *harness* | opt-in · global | memory projection | (is memory) |

**Spec is the only "always."** A crisp "done = X" is the cheapest doc and the anti-overthinking lever:
it's what lets the brain decide *"this is a one-liner, skip everything else."*

---

## 2. The linchpin: the **Contract**

Cold resumability, safe parallelism, and right-architecture-no-god-files all hang off one field — each
Task declares the **public surface it owns** (which modules/files, what interface it exposes).

- **Cold resume** → contract + context pointers let a fresh session execute without re-reading the world.
- **Parallel dispatch** → two tasks run in parallel **iff their contracts don't overlap**; they
  serialize via `deps` only where they touch the same seam. Mechanical, not a guess.
- **No god-files** → the boundary is decided *before* code is written, so the agent can't sprawl.

Architecture is a **chain, not one doc:** ADR sets the structural forks → Plan derives the module/
boundary map → each Task's `contract` is one slice of that map. The god-file problem is prevented at the
Plan→Contract derivation step.

> **Derivation rule:** task contracts come *from* the Plan's architecture map; two tasks serialize iff
> their contracts overlap.

---

## 3. Document structures

### 3.1 Spec — the self-contained root of a feature's truth (always)

```markdown
---
id: S-001
title: <feature>
status: draft        # draft | approved | superseded
---

## Problem / intent   — the why (JTBD), one paragraph
## Scope              — in / explicit non-goals (the boundary a cold agent needs)
## Acceptance criteria — AC1..n, each observable + verifiable (the contract with reality)
## Constraints        — tech / must / must-not (e.g. "use PNPM", "no new deps")
## Context            — links to code areas, relevant ADRs, recalled memory
## Open questions     — unknowns → feed Research
```

Acceptance criteria are **IDed** (`AC1..n`) so they trace to tasks (coverage) and to the assemble check.

### 3.2 Plan — the architecture carrier (earned · multi-step)

```markdown
---
id: P-001
status: draft
spec: S-001
adrs: [ADR-004, ADR-005]
---

## Approach           — overall strategy, how we get to done
## Architecture map   — modules/components + responsibilities + the seams between them   ← load-bearing
## Sequencing         — phases, what's parallel-able, risky-step-first
## Risks / unknowns    — what to validate early
```

The **Architecture map** is the section that earns the Plan: it names modules, responsibilities, and
interfaces — and **each task's `contract.owns`/`exposes` is sliced directly from it.**

### 3.3 Task — the unit of cold-resumable, parallel, bounded work (earned · multi-step)

Structured frontmatter (what the conductor + Workbench *read as data*) + prose body (what the agent +
reviewer read).

```markdown
---
id: T-003
title: Add session middleware
status: todo            # todo | in-progress | blocked | in-review | done
owner: implementer
lockedBy:               # agent id while status=in-progress → Workbench renders read-only (doc 10)
satisfies: [AC2, AC3]   # traceability → spec criteria (powers coverage check)
deps: [T-001]           # serialize only where contracts overlap
contract:
  owns: [auth/middleware.ts]
  exposes: "requireSession(req) -> Session"
---

## Background    — what is this and why
## Contract      — the owned surface, in human terms
## Gotchas       — warnings: recalled from memory at creation + discovered during the run
## Acceptance    — unit-level, independently checkable: [ ] test / command / observed behavior
## Out of scope  — what this task must NOT do
```

- `deps` + `contract.owns` **must** be structured → parallel-safety is mechanical, not parsed from prose.
- `status` drives the **Workbench lock**: `in-progress` → file renders read-only (`lockedBy` names the
  agent); nobody edits a task an agent already started (doc 10 §3).
- **`Gotchas` is the memory→task bridge.** At creation, recall pre-fills warnings for the files in
  `contract.owns`; during the run, new ones are appended and graduate back into memory. The second time
  you touch a file, the task is *born with yesterday's warning in it.* This is where the moat pays off.
- Task `## Acceptance` is *unit-level* ("verify this task"); Spec ACs are *product-level*; `satisfies`
  links them. Assemble later proves the product against the Spec ACs.

**Two correctness rules fall out for free:** every Spec AC must trace to ≥1 task (coverage check — kills
v1's silently-dropped criterion), and Task `## Acceptance` must be independently runnable.

### 3.4 ADR / Decision — structured, recall-friendly (earned · real fork)

Default to a **Y-statement**; expand to the full template only when the decision is big.

> *In the context of (use case), facing (concern), we chose (option), to achieve (quality), accepting
> (downside).*

```markdown
---
id: ADR-004
title: <decision>
status: accepted     # proposed | accepted | superseded (+ supersedes: ADR-00x)
---

## Context        — the forces driving it
## Decision       — the Y-statement core
## Alternatives   — what was rejected + why (the gold; stops re-litigation)
## Consequences   — commitments + accepted downsides
## Links          — spec, code, related ADRs
```

An ADR is the **heavy end of the `decision` continuum**: a trivial decision is a one-line memory fact; a
real architectural fork is an ADR. Born in the work folder, **graduates** on completion to the durable
`decisions/` store and registers a `decision`-type memory.

---

## 4. The lighter docs (same frontmatter+prose pattern)

- **Research** → `## Findings` (cited) + `## Implications` (what it changes in spec/plan).
- **Review / Verdict** → per-AC `PASS/FAIL` + **evidence/method cited** (no bare PASS — v1 lesson) +
  gotchas found.
- **Journal** → `task · shape · outcome · retries · lessons`. *This is* the episodic memory record.
- **Context map** → how the repo is built + where things live + key conventions.

---

## 5. Evolution — the self-evolution report (opt-in · meta)

Agentry reports its own **learnings / gaps / limitations** so it (and Claude Code) can improve. This is
**not a new system** — it reuses the memory pipeline: an evolution entry is a memory whose *subject* is
the harness, not the product.

- **Subject:** Agentry / Claude Code / a skill / an agent (≠ the user's product).
- **Scope:** mostly **global** (`~/.agentry`) — harness gaps are repo-independent.
- **Type:** `gap | limitation | learning`.
- **Flow:** captured on tooling friction during a run → distilled → **projected one-way** to a report doc.

```markdown
## [gap] Agentry overthinks one-liners
- **Observed:** run W-014 spawned plan+split for a 2-line fix
- **Evidence:** journal W-014, 3 wasted nodes      ← provenance, NON-NEGOTIABLE
- **Leverage:** P1 — visible waste, common case
- **Direction:** default-to-nothing routing rule (optional)
```

**Two flavors of "self-evolve":**
1. **Automated (in-band):** `consolidate` promotes recurring memory patterns into **skills** — Agentry
   gets better at recurring work without a human.
2. **Reported (human-in-loop):** harness gaps → this report → a human improves Agentry or takes a Claude
   Code gap upstream. Agentry generates the *signal*; it does not rewrite its own plugin code. "Self-
   evolving" = "generates its own roadmap," not "self-modifying."

**Discipline guard (or it becomes a complaint log):** durable/reproducible friction only (a one-off bad
run is a Journal entry, not an Evolution entry); distinguish "harness *can't*" from "model did poorly
this time." Every entry cites the run that surfaced it.

---

## 6. On-disk layout

```
.agentry/
  context.md              # repo map — onboarding, repo-level
  decisions/              # graduated ADRs — repo-durable
    ADR-001-….md
  work/
    <id>-<slug>/          # one folder per feature = one Workbench "feature"
      spec.md
      research.md         # earned
      plan.md             # earned
      tasks/              # earned — one file per task → independently lockable + parallel
        T-001.md
      reviews/            # verdicts
      journal.md          # outcome → feeds episodic memory
      events.jsonl        # append-only event log (agent started · on node X · spent N · done) — Workbench tails it (doc 10 §5)
      .review/            # comment/approve sidecars: <gate>.annotations.json (doc 10 §4)
  memory/                 # text-as-truth store + derived DB (.gitignored)
```

**Choices that matter:** one folder per work item (a feature's docs travel together → cold-resumable;
the Workbench renders a folder as a feature) · one file per task (independently lockable/statusable/
parallel) · ADRs graduate *out* of the transient work folder into durable `decisions/`.

**Workbench seams (V1 provides; V2 builds on — doc 10 §6):** every editable artifact carries a
`version` (content-hash) in its frontmatter for **optimistic concurrency** (a stale save is rejected, not
silently overwritten); tasks carry `lockedBy` (§3.3); the `events.jsonl` log and `.review/` sidecars are
the live + review contracts. These four data contracts are the only thing V1 owes the future Workbench.

---

## 7. Configuration seams (kept deliberately small)

Every toggle is a code path; an unbounded toggle set is how v1 accreted. The whole surface:

- `workDir` — the `.agentry/` location; one resolved path, injected everywhere, never hardcoded.
- `evolution.enabled` (default **off**) + `evolution.path` — the meta report.
- memory roots — global `~/.agentry` + optional per-project store (detail → memory doc).
- **`commit-or-not` is NOT config** — it's the user's `.gitignore`. The plugin behaves identically
  either way. Document it, don't branch on it.

Anything beyond this must *earn* a toggle.

---

## 8. Memory storage (referenced — full design in [02-memory.md](./02-memory.md))

Decided here only insofar as the layout depends on it:

- **Text files are the source of truth; the SQLite DB is a disposable, `.gitignored` index** rebuilt
  from them. Agent is the sole writer; humans read-only → the v1 bidirectional-sync bug class is gone.
- One file per memory · **content/ULID ids, never autoincrement** (kills merge-time id collisions) ·
  updates = **supersede, not mutate** (additive merges, provenance, "never recall superseded" for free).
- DB stays in sync trivially: agent writes are file-write + row-upsert in one operation; out-of-band
  changes (git pull/merge) are absorbed by an **atomic rebuild-on-session-start** (`files → DB`, pure
  function, temp+swap). Mid-session live sync deferred; a manual `resync` covers the gap.
- The Obsidian/wiki layer from v1 is **removed** — viewing is the Workbench's job; portability (if ever
  needed) is a one-way export, never a read-back sync.
- **Two tiers:** global (`~/.agentry`, personal, e.g. "always use PNPM") + project (`.agentry/`,
  committable so a team inherits gotchas/decisions).

---

## 9. Closed vs deferred

**Closed in this doc:** the document set + triggers · full structures for Spec / Plan / Task / ADR ·
the Contract linchpin + parallelism rule · the lighter docs · the Evolution report · the on-disk layout ·
config seams.

**Deferred (next docs):** memory internals (schema, recall ranking, distill, two-tier routing,
usefulness feedback) · the Workbench (rendering, edit/annotate/review loop, locking, live experience) ·
the routing/right-sizing brain · agents & skills roster.

---

_Signed-off: content generation surface is locked. Next: memory._
```
