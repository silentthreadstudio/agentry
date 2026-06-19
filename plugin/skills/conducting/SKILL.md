---
name: conducting
description: This skill should be used when acting as Agentry's conductor — routing a task to the least sufficient shape (one-shot / spec-first / decompose+verify), dispatching specialist subagents, gating approvals with the user, and sequencing a build end-to-end. Loaded by the /agentry:go front door.
version: 0.1.0
---

# Conducting

Run a task as Agentry's conductor: choose the **least process that wins**, dispatch specialists to do the work, gate decisions with the user, and keep the memory store warm. The conductor is the **main session** — the one place that can converse and gate; workers are isolated subagents that return distilled results.

## Two prime directives

1. **Bias to the floor — but the floor is set by the *hardest* signal, not the file count.** Over-routing is sunk, visible waste — *but under-routing a task that hides a decision is worse and invisible:* you silently **guess** the fork and ship a fragile default no one notices until it breaks (e.g. resolving an event's work-id by "newest-mtime folder" because no plan ever decided it). Don't be lulled by "under-routing is cheap to fix mid-flight" — the measured failure is that it *isn't* caught mid-flight; it ships. So: default to the floor for **genuinely** simple work, but **you may one-shot only after actively clearing the escalation check (§Right-size) — "I saw no reason to escalate" counts only if you actually ran the check.** The blunt rule: *if you can finish it in one edit / one agent without learning anything new AND it hides no decision, do it.* A **real unknown or an undecided design fork vetoes the floor** → **≥ spec-first regardless of how few files it touches.** Small footprint ≠ small decision.
2. **Guide, don't cage.** Use whatever tools/MCPs the user has (capability-first); never hard-restrict a specialist's tools or replace your own judgment with a fixed workflow.

## Interaction mode — interactive (default) vs auto-pilot

The conductor runs in one of two modes. **Mode changes *gating*, not *thinking*** — the routing, right-sizing, escalation check, spec/plan/split work, and the shapes you choose are **identical** in both. What differs is only what happens *at* a gate.

- **interactive (default)** — today's behavior, unchanged. At each gate you **stop and get the user** (see §Gating). The chat turn is the gate.
- **auto-pilot (opt-in, autonomous)** — you **never block**. At each gate you **decide → record → proceed**: pick the best option with stated rationale, write the decision artifact, name the auto-decided fork + the assumption + a one-line override hint *in that artifact*, and continue. Autonomous **and** accountable — every fork is surfaced and reversible, never silently guessed.

**Detecting the mode — check once, early (before the first gate):**
- Run `printenv AGENTRY_AUTOPILOT` via Bash. If it is `1`, auto-pilot is **ON**.
- Auto-pilot is also ON when running **headless** with no interactive user to gate with (a blocking gate would hang).
- Otherwise the mode is **interactive**.

Full mechanics — the decide→record→proceed protocol, the always-emit-artifact rule, and the override-hint format — live in `references/autopilot.md`. The rest of this skill describes the shared work; the mode only re-routes the gate steps.

## The loop

```
Recall → Right-size → [Spec gate?] → Dispatch → [Plan gate?] → Build ⇄ Verify → Assemble → [Ship gate] → Learn
```

Most tasks touch only part of this. A one-liner is `Recall → do it → Learn`.

1. **Recall.** Memory is primed at session start. Before deciding, recall precedent (*"tasks like this went well as `<shape>`"*) + gotchas for the files/subsystem in play. Recall **once** and thread what you find into each agent's brief — don't make every worker recall the same subsystem cold.
2. **Right-size.** Read the *shape of the prompt* (specificity · scope · reversibility · unknowns · **decision-content**) and pick the floor shape. Signals are **not equal votes**: the *highest-severity* one sets the floor, never the average. Let precedent inform, not dictate.

   **Mandatory pre-flight escalation check — run it before you may choose one-shot.** Ask, of the *actual* task (not a glance at file count):
   - **Hidden decision?** Could a competent engineer reasonably resolve this more than one way, where the choice carries a consequence — a key, a policy, a value, a default, a contract? (e.g. "merge two config files" hides *which side wins on conflict*; "add a retry" hides *the backoff policy*.) → the fork **vetoes one-shot → ≥ spec-first**, even for a one-file change.
   - **Real unknown?** An unfamiliar API / payload shape / identity / routing question you'd otherwise have to *guess*? → **≥ spec-first** (research/explore first).
   - **Multiple components?** Does it span several distinct concerns/layers/modules with seams between them — distinct contracts, not raw file count (e.g. a change the parser **and** the validator **and** the persistence layer must move together for)? → **decompose+verify**.
   - **Irreversible / high-blast-radius?** Migration, deletion, external write? → add a gate.

   A **YES on any line forbids one-shot.** Defaulting to one-shot *without running this check* is the under-routing failure — the most-failed conductor judgment. See `references/routing-and-dispatch.md` for the full signals→shape rubric.

   **Classify the *kind* too — a second, orthogonal axis.** Alongside (never instead of) the complexity shape, name the **kind** of work ∈ `{feature, bug, refactor, perf, dep-upgrade, ci-red}`. On **any escalation above one-shot**, record it as `kind: <kind>` in the `spec.md` frontmatter you already write (a genuine one-shot writes no `spec.md` → its kind lives in the run trace/episode only). **Kind ⊥ complexity — the load-bearing invariant:** classifying kind never forces a complexity shape and vice-versa. A `bug` may route one-shot *or* decompose+verify; a `feature` may be either too. **Kind selects the *discipline*; complexity selects the *process weight*.** In particular `bug / ci-red / perf` select the **debug discipline** (the tightened `implementing` "When fixing" mode: reproduce-first → regression-guard); the other kinds use the default build discipline. The kind→discipline map lives in `references/routing-and-dispatch.md`.
3. **Dispatch.** Send work to specialists (the ladder below). Pass each a self-contained brief: the contract, the recalled gotchas, the acceptance. Parallelize only where task contracts don't overlap.
4. **Gate** at the decision points (below). Gating needs the user — that's why you're the main session. **Each gate's artifact (`spec.md`, `plan.md`, task files) is written to `.agentry/work/<id>/` as a file *before* you gate** — reasoning it out in chat without persisting the file is the failure (the Workbench and re-review read the files, not the transcript).
5. **Verify / Assemble.** A *separate* verifier proves the work; assemble runs the whole product against the Spec's acceptance criteria. See the build loop below.
6. **Learn.** Record the episode; harvest gotchas the verifier named; offer to reflect.

## Escalation triggers (pre-flight AND mid-flight)

Touched far more files than expected · failed verify twice · discovered a real unknown mid-task · hit an irreversible/high-blast-radius step. These fire **mid-flight** — re-enter at the *smallest sufficient* node, never restart. Their **pre-flight equivalents set the initial floor** (§Right-size): an unknown or a design fork you can already see in the prompt escalates *before* you touch code — not only once it surfaces mid-task. The fork is usually visible up front; catch it then.

## Dispatch ladder

- **one-shot** → act inline. No dispatch.
- **medium → most complex (default)** → dispatch specialist subagents by judgment; parallel where contracts are disjoint.
- **huge mechanical fan-out (rare escape hatch)** → a dynamic workflow. Workflows are a *fixed flow* and constrain creativity, so use them only for large, well-defined, low-creativity fan-out — never for normal feature work, and never *as* the conductor (they take no mid-run user input).

## Gating (the conductor's job — workers can't do this)

> **Mode-dependent (§Interaction mode).** The gates below describe **interactive** mode. In **auto-pilot** the *artifacts* below are still written — the **stop** is replaced by **decide→record→proceed**: you do NOT block and do NOT call a blocking `AskUserQuestion` to obtain a gate decision; you pick the best option, record the chosen option + assumption + override hint in the artifact, and continue. The escalation check and the artifact contract are unchanged. See `references/autopilot.md`.

On **spec-first and decompose+verify these gates are mandatory stops, in order — do not collapse or skip them.** A worker NEVER advances past a gate on its own; in interactive mode you stop and get the user.

- **Spec is always a written artifact — on ANY escalation above one-shot.** The instant you escalate above one-shot — *including* a small fork you'd otherwise resolve with one inline question — produce `spec.md` (intent + observable acceptance criteria) as a *file*. Never inline the acceptance criteria into a worker's brief, and never gate a fork via `AskUserQuestion` while writing no `spec.md` — that's the inconsistency to kill (a one-function "dedupe" task that detects a real fork must still emit `spec.md`). A **genuine one-shot writes nothing** to `.agentry/work/` — it just does the edit. This rule holds in **both** modes; auto-pilot additionally records the chosen option + override hint in the artifact instead of gating. (doc 01: Spec is the always-emitted artifact.)
- **Spec gate** — present `spec.md` and confirm "done = X" with the user before planning. Mandatory when the work is **under-specified _or_ the goal is specified but the design/mechanism is undecided** (a fork the solution hinges on) — not just the vague "make X better" case. A specified goal with an open mechanism (e.g. "emit events" where *how/where* is undecided) still needs the spec gate. On a genuinely clear task, still surface the spec for a quick confirm before you plan.
- **Plan gate** — **plan first, gate, *then* split.** Dispatch the architect for **Plan + ADR only** (NOT tasks). Optionally run the verifier's plan-lens (falsifiable acceptance? contracts compose? riskiest first?). Present the Plan + any ADR to the user and get approval. **Only after approval** do you dispatch split (task contracts). Never bundle plan→split into one dispatch — that removes the gate.
- **Ship gate** — on an assemble MEETS verdict, offer {commit+PR / keep iterating / reflect}.

> **Outward-action authorization (pointer).** For ship steps that leave the machine, the conductor evaluates `authorize(action)` against the `shipping` boundary's `local`/`outward` vocabulary — the three outward actions `{push, pr-open, merge}` default to `gate`, so no outward action is ever the autonomous default. Full semantics live in the `shipping` skill; here, just acknowledge the gate.

> The anti-pattern that bit us live: a clear task tempts you to inline the ACs, skip `spec.md`, and dispatch the architect to produce plan+ADR+tasks in one pass — collapsing both gates. Don't. The artifact + the stops are the point — and the artifact is a **file on disk** in `.agentry/work/<id>/`, not a chat message.

> **FLOW on escalated runs (pointer).** Each gate reached and each routing decision is an `event_emit(run, …)`, and each gate artifact (`spec.md`, `plan.md`) is written through `artifact_write(run, …)` — see §FLOW. The artifact is still a **file on disk** in `.agentry/work/<run>/`; `artifact_write` is how you write it (and stamps `version`), not a substitute for it. This applies above the one-shot floor only.

**Work-folder layout** (the same in every repo): `spec.md` and `plan.md` are single docs at the **root**; **`adr/NNN-slug.md`** and **`tasks/NNN-slug.md`** (+ `tasks/coverage.md`) are **always folders** — ADRs and tasks are numbered, append-only series, so `adr/` and `tasks/` are folders *even with a single entry*. An ADR at the work-dir root is wrong; it goes in `adr/`.

## FLOW — the orchestration record (escalated runs only)

On any run **above the one-shot floor** (spec-first / decompose+verify), record the orchestration through the **`flow` MCP** (`mcp__…_flow__*`) so the run's state is structured and correct-by-construction, not prose-narrated. The skill *mandates* these calls; they are not optional narration.

- **`run_start` FIRST — hold the returned `run` handle.** Begin the run by calling `run_start(goal)` *before* any other FLOW call or any artifact write. It mints and returns a **`run` handle**; **thread that explicit `run` into every subsequent FLOW call** (`task_*`, `event_emit`, `artifact_write`, `agent_*`, `review_*`, `run_get`/`run_status`). Per **ADR-005 (NO branch)** the stdio FLOW server has **no ambient "current run"** — `run` is a **required argument** on every tool, never resolved server-side; a FLOW call before `run_start` is an error. If you know this session's `session_id`, pass it to `run_start` so it seeds the session→run pointer proactively; if not, omit it and the `work-id-binder` hook seeds the pointer reactively on the first Write.
- **Write a spec/plan ⇒ `artifact_write`** (threading `run`) — it stamps the `version` content-hash. Do this *as* you write each gate artifact (`spec.md`, `plan.md`).
- **Each routing decision / gate reached / node enter·done ⇒ `event_emit`** (threading `run`). The **conductor is the primary event emitter** — the `flow` stream is the rich record (shape + kind, gate, node + duration); the `subagent-emit` hook is only the backstop.
- **CHECKPOINT — proportional (AC7).** This entire FLOW mandate applies **only above the one-shot floor.** A **one-shot run calls NOTHING through FLOW** — no `run_start`, no `task_*`, no `event_emit`, no `artifact_write`. Never impose FLOW ceremony on a one-shot; right-sizing already decided it didn't need orchestration state. (This mirrors §Gating: a genuine one-shot writes nothing to `.agentry/work/`.)

## Build loop (implement ⇄ verify)

After the plan gate, run each task: dispatch the **implementer** → dispatch a **separate verifier** (never the author — that independence is the point).

- **Record the task lifecycle through FLOW (escalated runs).** On **dispatch** of a task, call `task_assign(run, …)` (sets the assignee / `lockedBy`) **and** `task_status(run, in-progress)`; on the worker's **return**, call `task_status(run, in-review)` then `task_status(run, done)` once it passes — every call threading the explicit `run` handle from `run_start`. The status enum is closed and the assignee can't be forgotten because the tool enforces them; this is what makes the task files carry live status, not drifted prose.
- **Fix loop = fresh implementer + the verifier's fix contract.** When verify returns needs-changes, **re-dispatch a *fresh* implementer with the verifier's precise findings as the contract** — clean context, exact refs. A fresh spawn carrying the fix contract is reliable and reproducible; don't rely on resuming a prior agent's muddied context.
- **Keep build artifacts in sync, run the project's checks.** If the project compiles/bundles source into a committed or runtime-loaded artifact, rebuild it after changing source so the two don't drift; run the project's build · lint · tests · any gate before the ship gate. **Discover those commands** from the repo (package.json scripts, Makefile, CONTRIBUTING, `CLAUDE.md`, repo-facts) — never assume. A project's specific rules (e.g. a build-output-lockstep) live in *its* `CLAUDE.md`/memory, not in this skill.

## Memory discipline

- **Recall once, thread to agents** — agents recall narrowly (the specific function/bug), you provide the subsystem context.
- **Cite usefulness** — collect each agent's `used_memories`; at close, feed the citation + outcome back (`memory_feedback`) so useful memories rise and noise decays.
- **Harvest gotchas** — when the verifier names a gotcha in a verdict, write it (the verifier stays read-only for independence).
- **Close the loop** — `episode_write` the run (task · shape · outcome · retries) before offering reflect; surface undistilled-episode debt at the decision point.

## The full-feature sequence (fully escalated; collapse to taste)

```
product-owner (Spec) → [spec gate] → designer (UX, if UI) → architect (Plan + ADRs)
  → [plan-lens + plan gate] → implementer ⇄ verifier (parallel where contracts disjoint)
  → designer (sees rendered UI) + verifier (assemble vs ACs) → [ship gate] → librarian (reflect)
```

Node↔specialist mapping and the signals rubric live in the reference.

## Anti-patterns (refuse)

- **Over-orchestrating** — spec/plan/split for a one-liner. The worse failure; it's visible waste.
- **Re-implementing node work** — writing code/plans yourself instead of dispatching. You conduct.
- **Skipping the spec gate** on a vague ask → building the wrong thing.
- **Parallelizing overlapping contracts** → silent clobbering.
- **Not threading memory** → every worker re-explores the same subsystem cold.
- **Gating in chat without the artifact file** → spec/plan must exist in `.agentry/work/<id>/`, not just the transcript.
- **Committing source without rebuilding the artifact it generates** → the runtime loads the build output, not source; keep them in sync per the project's build.

## Additional resources

### Reference files
- **`references/autopilot.md`** — auto-pilot mode in full: the `AGENTRY_AUTOPILOT` / headless trigger, the decide→record→proceed protocol, the always-emit-`spec.md` rule, and the decision-artifact + override-hint format (the surfaced-and-reversible safety contract).
- **`references/routing-and-dispatch.md`** — the signals→shape rubric, escalation-trigger detail, the dispatch ladder, the node↔specialist map, and gating points with the artifacts each produces.
- **`references/judgment.md`** — the senior reasoning *upstream* of the rubric: evaluating uncertainty (known vs. real unknown · the bet test), complexity (footprint vs. decision-content), the hardest-signal-not-the-average rule, one-way/two-way-door trade-offs, and right-sizing worked examples + self-catch list.
