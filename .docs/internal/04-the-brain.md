# 04 — The Brain: Routing, Dispatch & the Conductor

> **Status:** Locked (iteration 1) · **Date:** 2026-06-13 · **Scope:** the front door — how Agentry
> evaluates a task and dispatches it across the whole range, **simplicity → maximum complexity**, while
> staying fast and not overthinking. Grounded against the Claude Code reference docs (sweep 2026-06-13).
>
> Depends on: the doc-scaling (01), memory (02–03). Feeds: the roster (next).

---

## 0. Governing principles

**P1 — Bias to the floor (cost is asymmetric).** Under-routing is cheap to fix (a one-shot that turns
hairy *escalates mid-flight*, losing almost nothing); over-routing is **sunk, visible waste** (a plan for
a one-liner can't be refunded). So: **default to the floor, escalate on evidence.** Reliability comes
from the *escalation valve + verification*, not from planning everything up front. This is the fix for
v1's overthinking.

**P2 — Guide, don't cage.** Prefer **soft guidance** (role, craft skill, prompt) over **hard locks**
(fixed workflow scripts, per-agent tool allowlists). Hard locks kill **creativity** (a fixed flow stops
the model reasoning) and **portability** (a tool allowlist breaks when a user brings their own tools/
MCPs). Agentry must run well in *any* user's environment with *any* toolset. A Smart Brain ≠ a fixed
pipeline.

---

## 1. The blunt floor + the shapes

The brain needs a *blunt* floor, not just a nuanced rubric — nuance drifts back toward ceremony:

> **If you can finish it in one edit / one agent without learning anything new — do it. Writing a plan
> for that is the failure, not the safe choice.**

Shapes are a spectrum mapped to the locked doc-scaling (01):

| Shape | What runs | Docs | When |
| :--- | :--- | :--- | :--- |
| **one-shot** | sharpened single agent (skill + memory primed) | none | clear + small + reversible |
| **spec-first** | write Spec → do it | Spec | small but **under-specified** ("make X better") |
| **decompose+verify** | Spec → Plan → Tasks → build↔verify → assemble | full | multi-file / complex / unknowns |

(research/explore are *optional upstream* when there are real unknowns.) The brain picks the **floor** and
escalates by **re-entering at the smallest sufficient node** — never restarts.

---

## 2. How it decides — cheap signals, not deliberation

Read the *shape of the prompt* first; investigate only if genuinely ambiguous. Signals:

- **Specificity** — is "done = X" clear, or vague?
- **Scope** — one file/symbol, or many modules?
- **Reversibility / blast radius** — trivially undoable, or risky?
- **Unknowns** — do I know how, or is there research to do?
- **Precedent (memory)** — *"tasks like this went well as `<shape>`; this seam has gotcha `g:37`."* An
  **input, not a mandate.** Improves as the store warms → adaptive routing, the moat feeding the brain.

**Escalation triggers** (concrete, so escalation isn't a vibe): touched far more files than expected ·
failed verify twice · discovered an unknown mid-task · hit an irreversible step. Any one → step up one
shape, re-enter, continue.

---

## 3. Mapping to Claude Code primitives (validated by the doc sweep)

| Concept | Primitive | Note |
| :--- | :--- | :--- |
| **Brain / conductor** | the **main session**, opened by `/agentry` (a skill/command) | must converse + gate → only the main loop can |
| **Routing + escalation craft** | a **skill** (rubric, triggers, least-process discipline) | craft, not prose bloat in a command |
| **Nodes** (spec, plan, verify…) | thin **commands** `/agentry:<node>` (plugin-namespaced) | standalone *and* composable |
| **Specialists** | **subagents** in isolated context, returning a distilled text result | fixes context pollution |
| **Craft** | **skills**, `skills:`-preloaded onto agents | confirmed: role in agent, craft in skill |
| **Memory priming + recall** | **SessionStart hook** (injects context; sees `agent_type` → prime conductor only) + **memory MCP** | both at **plugin root** (§6) |

---

## 4. The dispatch ladder — and where workflows sit

Dispatch scales with complexity, mirroring the shapes:

| Work | Mechanism |
| :--- | :--- |
| one-shot | conductor acts **inline** — no dispatch |
| medium → most complex (**the default**) | conductor **dispatches subagents** (Agent tool) by judgment; parallel where contracts don't overlap; each creative in its own context |
| huge mechanical fan-out (**escape hatch, not a tier**) | a **dynamic workflow** — only when work is large, well-defined, and creativity isn't the point (e.g. the same transform across 50 files) |

> ⚠️ **Workflows are a fixed flow → they constrain Claude's creativity** (confirmed in the v1 experiment:
> they work, but they're rigid). They are the **antithesis of the Smart-Brain thesis**, so they are a
> *rare opt-in escape hatch*, **never the default** for feature work. The conductor's creative,
> judgment-driven subagent dispatch is the workhorse. (They also can't take mid-run user input — a second
> reason the *conductor* is never a workflow; see §5.)

Parallel safety for the default path: an implementer may run with **`isolation: worktree`** (its own temp
branch) so non-overlapping-contract tasks **can't clobber each other** — the conductor merges/discards.
This is *file safety*, not a creativity/tool restriction, so it's allowed (and optional).

---

## 5. Guide-don't-cage, in practice

- **No per-agent tool allowlists.** Specialists **inherit the user's environment** — their tools, their
  MCPs, whatever they bring. Tool use is steered by **role + craft + prompt**, never hard-restricted via
  `tools:`/`disallowedTools`. Rationale: another user's setup differs from ours; a hard allowlist makes
  Agentry brittle and non-portable. (Reverses the doc-sweep's "scope tools per specialist" suggestion —
  *rejected* on portability grounds.)
- **The conductor is the main session, never a workflow.** Gating ("approve this plan?"), conversation,
  and the review loop **need the user**, and workflows take *no mid-run user input*. Gates happen
  *between* stages, in the main session.
- **Soft tuning only, never tight clamps.** `model`/`effort` per role (capability, fine); `maxTurns` kept
  *generous* as a runaway backstop, not a creativity cutoff; **output styles** may carry role personas
  (conductor = orchestration-focused, implementer = proactive) — all optional, none caging.

---

## 6. The plugin-layout constraint (hard rule from the sweep)

**Plugin-bundled agents cannot embed `hooks`, `mcpServers`, or `permissionMode`** (Claude Code security
rule). Therefore the **memory MCP and the SessionStart priming hook live at the plugin root**
(`.mcp.json` + `hooks/`), shared across all specialists — not inside agent definitions. (No downside for
us: priming/memory is shared by design.)

*Caveat:* verify exact frontmatter spellings (`skills:`, `isolation:`, `model:`, `effort:`, `maxTurns:`)
against the live docs at build time — the capabilities are confirmed; the exact keys are worth a check.

---

## 7. Parked for later (research leads)

- **Workbench V2 may get "see agents working" + remote gating *natively*:** the `/workflows` progress
  view, **agent-view** session-state files (`~/.claude/jobs/<id>/state.json`), and **channels'
  permission-relay** (forward an approval prompt to an external UI, reply async). May avoid hand-rolling
  live-status + gate transport. → Workbench doc.
- **Benchmarking the brain:** `claude -p --output-format json` + `--bg` → headless, machine-readable runs
  = the harness for the warm-store north-star test.
- **`advisor`** (consult a stronger model at a decision point) — possible self-escalation for a worker on
  a hard call. Low priority, orthogonal to orchestration.

---

## 8. Open / to-benchmark

| Knob | Iteration-1 default | What we measure |
| :--- | :--- | :--- |
| Floor bias | blunt "one edit → just do it" | over- vs under-routing rate (over-routing is the worse failure) |
| Escalation triggers | files-surprise · 2× verify-fail · unknown · irreversible | do they fire at the right time, not too late? |
| Precedent weight in routing | recall similar episode + outcome | does precedent improve route choice as the store warms? |
| Workflow threshold | huge mechanical fan-out only | is the escape hatch ever the *right* call, or never needed? |

**North-star (unchanged):** beats a plain session on multi-file + under-specified work; warm-store run #2
beats run #1.

---

## 9. Closed vs deferred

**Closed:** the two governing principles · the blunt floor + shapes · cheap-signal routing + escalation
triggers + precedent · the Claude Code primitive mapping · the dispatch ladder (workflows = rare escape
hatch) · guide-don't-cage (no tool allowlists; conductor = main session) · the plugin-root constraint.

**Deferred (next):** the **roster** — exact agent list, skill list, and agent↔skill pairing · the
**MCP tool shapes** + type enum + priming-hook implementation · the **Workbench** (V2) · the
**benchmark harness**.

---

_Signed-off (iteration 1): the brain is locked — a Matrix-like conductor that right-sizes from one-shot to
full decompose, dispatches creatively (not via fixed flows), and never cages the user's environment.
Next: the roster._
