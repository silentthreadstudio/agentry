---
name: product
description: This skill should be used when defining the *what & why* of a unit of work — turning an under-specified goal ("make X better") into a Spec: capturing the job-to-be-done, setting scope and explicit non-goals, prioritizing to the smallest valuable slice, designing information architecture, and writing observable, verifiable acceptance criteria. Loaded for definition/scoping work, not for designing the solution or building it.
version: 0.1.0
---

# Product

Turn an under-specified goal into a **crisp Spec** whose acceptance criteria are checkable by *observed behavior*, not opinion. The Spec is the contract with reality: tasks `satisfies:` its ACs (coverage), and the assemble check grades the finished product against them. Define the **need**, never the solution — the *what & why*, not the *how*.

## The one rule that governs every Spec

**Observable or it doesn't count.** Every acceptance criterion must be something a stranger could verify by running, clicking, or measuring — with no access to your intent. If checking it requires a judgment call ("feels fast", "is intuitive", "is robust"), it is not an acceptance criterion yet. Rewrite it as behavior, or cut it.

## Method

Work in this order; stop early when the goal is small and clear enough not to need the later steps.

1. **Find the job-to-be-done.** State, in one line, what the user is trying to accomplish and *why*. Strip out any solution language — "add a Redis cache" is a how; "results load fast enough that users don't abandon the page" is the why. Design follows; it does not lead.
2. **Set scope + explicit non-goals.** Name what's in, and — load-bearing — what's *explicitly out*. Non-goals are the cheapest scope-creep defense; an unbounded "better" has no edge.
3. **Prioritize to the smallest valuable slice.** Use value-vs-effort or MoSCoW (Must / Should / Could / Won't). Ship the Must; park the rest as non-goals or future Specs. Right-sizing the *need* is as important as right-sizing the design.
4. **Design the information architecture** (when product- or docs-shaped) — the user-facing structure: what concepts exist, how they're named, how they're navigated. Bad IA is a need failure, not a styling one.
5. **Write the acceptance criteria** — `AC1..n`, each observable + independently verifiable. See *Writing observable ACs* below.
6. **Capture the rest of the Spec** — Constraints (must / must-not), Context (links to code, ADRs, recalled memory), Open questions (unknowns → feed Research).

## Writing observable acceptance criteria (the craft)

An AC is a **testable claim about behavior**. The shape that works:

> Given **\<context\>**, when **\<action\>**, then **\<observable outcome\>**.

Make each AC:

- **Observable** — verifiable by watching what the system does, not by reading the author's mind.
- **Specific** — names the actor, the trigger, and the measurable result (a number, a state, a visible output).
- **Atomic** — one claim per AC, so it can pass or fail alone and trace to one or more tasks.
- **IDed** — `AC1..n`, so tasks declare `satisfies: [AC2, AC3]` and the coverage matrix can prove nothing was dropped.

| Vague (reject) | Observable (accept) |
| :--- | :--- |
| "Login is fast" | "AC1: login completes in <500ms p95 on the staging dataset" |
| "Errors are handled" | "AC2: submitting an empty form shows an inline 'required' message and does not POST" |
| "The export works" | "AC3: exporting 1,000 rows yields a CSV whose row count equals the table's, headers included" |
| "Onboarding is intuitive" | "AC4: a new user reaches the first saved project in ≤3 screens with no dead ends" |

If you cannot phrase the outcome as something to *observe*, the requirement is still a wish — push it back to a measurable form or move it to Open questions.

## Right-sizing the definition itself

The Spec is the **only always-on doc**, but it scales. A tiny, clear task gets a one-line spec — don't impose JTBD-ceremony on a backend one-liner. Escalate to full scope/prioritization/IA only when the goal is genuinely under-specified or product-shaped. Over-defining small work is the product-tax this skill exists to avoid.

## Output

A shaped **Spec** (doc-01 format): Problem/intent (JTBD) · Scope + explicit non-goals · `AC1..n` (observable + verifiable) · Constraints · Context · Open questions — ready for the conductor to gate with the user. Report any memory that shaped the Spec in `used_memories`.

## Anti-patterns (refuse these)

- **Unverifiable AC** — checkable only by opinion. The single most common failure; rewrite as behavior or cut.
- **Solution in the Spec** — naming a library, schema, or architecture. That's the architect's, downstream of you.
- **Boundary-less scope** — no non-goals, so "better" sprawls into gold-plating.
- **Bundled jobs** — several JTBD fused into one fuzzy Spec; split or sequence them.
- **Guessed threshold** — inventing a number for an unknown instead of flagging it in Open questions.

## Additional resources

### Reference files
- **`references/acceptance-criteria.md`** — the deep treatment: JTBD framing, the Given/When/Then and checklist forms, making the un-measurable measurable, prioritization (MoSCoW / value-vs-effort), the coverage matrix, and a catalog of vague→observable rewrites.
