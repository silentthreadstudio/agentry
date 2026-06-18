# Auto-pilot mode — depth

Reference for the `conducting` skill: how the conductor runs **unblocked** when there is no interactive user to gate with, while staying accountable. Auto-pilot changes **gating, not thinking** — every routing, right-sizing, escalation, and shape decision is made exactly as in interactive mode. Only the behavior *at* a gate differs.

## The two modes

| | **interactive** (default) | **auto-pilot** (opt-in) |
| :--- | :--- | :--- |
| At a gate | **stop**, present the artifact, get the user | **decide → record → proceed** — never block |
| How a fork is resolved | the user chooses | you pick the best option, **named + reversible** in the artifact |
| `AskUserQuestion` for a gate decision | yes (the chat turn is the gate) | **no** — a blocking question would hang headless |
| Artifacts (`spec.md`, `plan.md`, `adr/`, `tasks/`) | written before the gate | written **identically** — plus the chosen option + override hint |
| Routing / shape / escalation check | unchanged | **unchanged** |

## Detecting the mode — once, early (before the first gate)

1. Run `printenv AGENTRY_AUTOPILOT` via Bash. Value `1` → auto-pilot **ON**.
2. Otherwise, if running **headless** with no interactive user to gate with (a blocking gate would hang) → auto-pilot **ON**.
3. Otherwise → **interactive** (the default).

Check it before you reach the spec gate; the result holds for the whole run.

## The decide → record → proceed protocol (at every gate)

When a gate is reached in auto-pilot, for each decision the gate would have asked the user:

1. **Decide.** Pick the best option using the same judgment you'd present interactively. State the rationale — *why this option over the alternatives*.
2. **Record — in the artifact, not in chat.** Write the decision into the gate's artifact (`spec.md` at the spec gate; `plan.md` / `adr/NNN-*.md` at the plan gate). The record names:
   - the **fork** — what was genuinely undecided (the key / policy / value / default / contract at issue);
   - the **chosen option** + one-line rationale;
   - the **assumption** the choice rests on;
   - a one-line **override hint** — exactly how a human reverses it (which line/field to change, or which alternative to pick instead).
3. **Proceed.** Continue the loop. Do **not** block, and do **not** emit a blocking `AskUserQuestion` to obtain the decision.

> **Decide ≠ guess.** The fork is still surfaced (named in a file on disk) and still reversible (the override hint). That is the line between auto-pilot and reckless: **autonomous AND accountable**, never *silently* guessed. A fork resolved inline with no artifact is the failure this mode exists to prevent.

## The always-emit-artifact rule (the inconsistency this fixes)

**On ANY escalation above one-shot, emit the decision artifact — minimum a `spec.md`** in `.agentry/work/<slug>/`. This includes a *small* fork you would otherwise have settled with a single inline question.

- The bug it kills: the conductor escalating a small fork via an inline `AskUserQuestion` while writing **no `spec.md`** (a one-function "dedupe" task detected a real fork, gated via the question, but produced no artifact — so the routing decision left no trace).
- The symmetric floor: a **genuine one-shot writes nothing** to `.agentry/work/` — no fork, no decision, just the edit. The presence of a work-folder artifact *is* the signal that an escalation happened.

This rule holds in **both** modes. Auto-pilot only adds the override hint to the artifact in place of the gate stop.

## Decision-artifact format (the surfaced-and-reversible record)

Append an **Auto-pilot decisions** section to the gate's artifact. Suggested shape (keep it terse; one block per fork):

```md
## Auto-pilot decisions
- **Fork:** <the undecided question — what carries the consequence>
  **Chose:** <option> — <one-line rationale>
  **Assumes:** <the assumption the choice rests on>
  **Override:** <how a human reverses it — the line/field/alternative>
```

Put it in `spec.md` for spec-gate forks and in `plan.md` (or the relevant `adr/NNN-*.md`) for plan-gate forks, alongside the normal content.

## Work-folder layout (unchanged in both modes)

`<cwd>/.agentry/work/<slug>/`:
- `spec.md`, `plan.md` — single docs at the **root**.
- `adr/NNN-slug.md`, `tasks/NNN-slug.md` (+ `tasks/coverage.md`) — **always folders**, numbered append-only series, even with a single entry.

Auto-pilot writes the **same files in the same places**; it does not introduce a new layout.
