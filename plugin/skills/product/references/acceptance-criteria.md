# Acceptance Criteria & Scoping — depth

Reference for the `product` skill. The Spec's value is concentrated in its acceptance criteria: they are the contract every downstream stage is graded against. This file is the deep craft for writing them well, and for the scoping that surrounds them.

## Job-to-be-done — frame the need, not the feature

Before any AC, name the job. A JTBD is **"when \<situation\>, I want to \<motivation\>, so I can \<outcome\>."** It is deliberately solution-free:

- Feature framing (avoid as the root): "Add a dark-mode toggle."
- JTBD framing (use): "When I work at night, I want the UI to stop straining my eyes, so I can keep working comfortably."

The JTBD opens the solution space (dark mode is *one* answer; auto-dimming is another) and gives the ACs something real to verify against. Lead the Spec's Problem/intent with it.

## The two canonical AC forms

**Given / When / Then** — best for behavioral, interaction-driven criteria:

> Given a logged-out visitor, when they submit valid credentials, then they land on the dashboard within 2s and a session cookie is set.

**Checklist / observable-state** — best for content, data, or structural criteria:

> AC: The exported CSV contains a header row and exactly one row per visible table record; numeric columns are unquoted.

Both share the non-negotiable: the **then/outcome is something you can observe**. Pick whichever reads clearer for the criterion; don't force one shape.

## Making the un-measurable measurable

Most "vibe" requirements *can* be made observable by asking "what would I see if this were true?"

| Wish | The observable proxy |
| :--- | :--- |
| "fast" | a latency budget at a percentile on a named dataset (`<500ms p95`) |
| "intuitive" | a task-completion proxy (reaches goal in ≤N steps, no dead ends) or a measured success rate |
| "reliable" | a failure-rate bound, or "survives \<specific fault\> without data loss" |
| "accessible" | passes \<specific checks\>: keyboard-navigable, contrast ≥4.5:1, labels present |
| "secure" | a named threat is blocked: "an unauthenticated request to /admin returns 401" |
| "clear" copy | "a first-time reader can state what the feature does after reading the first sentence" |

If no honest proxy exists yet, that's a real unknown — put it in **Open questions** and flag for research. Never invent a number to fake measurability.

## The quality bar for one AC

A good AC is **INVEST-flavored** at the criterion level:

- **Independent** — passes or fails without depending on another AC's interpretation.
- **Observable** — verifiable from outside, by behavior or measurable state.
- **Atomic** — one claim. If it has "and", consider splitting so each half can trace and fail alone.
- **Negative-aware** — where it matters, also specify what must *not* happen (no POST on invalid input; no PII in logs).
- **Bounded** — names the conditions/dataset/environment it's checked under, so "done" isn't context-dependent.

## Prioritization — scoping the slice

The Spec should describe the **smallest version that delivers the value**, with everything else bounded out.

**MoSCoW:** Must (the slice fails without it) · Should (important, not vital) · Could (nice, low cost) · Won't (explicitly out — this *is* a non-goal, write it down). Only Musts belong in the shipped slice's ACs by default.

**Value vs. effort:** plot each candidate. High-value/low-effort first; high-effort/low-value becomes a non-goal. This is how you resist gold-plating without losing the idea — it's parked, not lost.

**Non-goals are first-class.** A Spec with no explicit non-goals has no boundary, and an unbounded "make it better" is how scope creeps. Write the non-goals as plainly as the goals.

## Coverage — ACs are the spine of the pipeline

Acceptance criteria are IDed (`AC1..n`) for one structural reason: **traceability**.

- Each Task declares `satisfies: [AC…]`. Build the **criterion→task matrix**: every AC must trace to ≥1 task. An AC with no task is a silently-dropped requirement — catch it here, the cheapest place.
- Task-level `## Acceptance` is *unit* granularity ("this task works"); Spec ACs are *product* granularity ("the feature is done"). The assemble step proves the product against the Spec ACs. Keep the two altitudes distinct and let `satisfies` link them.

An AC that can't be traced to a checkable task is usually an AC that wasn't observable enough — a feedback signal to sharpen it.

## Vague → observable, worked rewrites

- ❌ "Search should return good results." → ✅ "AC: a query for an exact product title returns that product in the top 3 results."
- ❌ "The page should look professional." → ✅ "AC: the page passes the design review checklist (spacing scale, single type scale, no overflow at 320px width)." (and route the look itself to the designer)
- ❌ "Handle large files." → ✅ "AC: uploading a 100MB file completes without timeout and shows a progress indicator that reaches 100%."
- ❌ "Make the API more consistent." → ✅ "AC: all list endpoints return `{ data, page, total }`; a contract test asserts the shape across the 6 list routes."

The pattern is always the same: replace the adjective with the **thing you'd observe** to know the adjective is true.
