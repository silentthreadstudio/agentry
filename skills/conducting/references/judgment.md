# Right-sizing Judgment — depth

Reference for the `conducting` skill: the senior reasoning **upstream** of the signals→shape rubric. The rubric in `routing-and-dispatch.md` consumes signals; this is how you *evaluate* them honestly before you read them off a table. The one rule it hardens: **the floor is set by the hardest signal — and an unknown or an undecided fork vetoes it.** That rule is only as good as your honesty about which signals are real.

This is the highest-leverage, most-failed judgment in the system. Slow down here.

## 1. Evaluating uncertainty — known vs. real unknown

A **known** is something you can act on now: you've done it before, the API is one you've actually used, the behavior is stable and you'd stake the build on it. A **real unknown** is a question whose answer you cannot produce from what you hold — an unfamiliar library/API or its current version behavior, an unverified payload/wire shape, an identity/routing question ("how does *this* caller learn *that* id"), or a floating claim ("is X still true?"). Unknowns must be **surfaced or researched, never guessed**.

The hard part is that a guess *feels* like knowledge. The tells that separate them:

- **The bet test.** *If I had to bet the build on this being true, would I?* If you hesitate, it's an unknown — treat it as one.
- **Provenance.** Can you name *where* you know it from (you ran it, you read current docs, a memory cites it)? "It's probably like the other one" is a guess wearing a known's clothes.
- **Recency.** Anything whose truth has a *date* — versions, pricing, best practice, a revised standard — decays. A confident memory of it may be stale. Recency-sensitive ⇒ verify.
- **The shrug.** If your honest internal answer is "I think…" or "usually…", that's the unknown announcing itself.

A real unknown **vetoes the floor**: it forces **≥ spec-first regardless of footprint**, and if the answer is external/recency-bound, it routes to research *before* design. The expensive failure mode is the silent one — guessing the unknown inside an edit, where no gate ever sees it.

## 2. Evaluating complexity — footprint vs. decision-content

Two different things wear the name "complexity," and conflating them is the core error.

- **Footprint** — files/lines/modules touched. Cheap to see, so it's the proxy everyone reaches for. It is *visible* but *weakly* correlated with difficulty.
- **Decision-content** — the number and weight of **forks the solution hinges on**: choices with real alternatives and lasting consequences. This is the actual driver of how much process the work needs.

**Footprint is a misleading proxy** because the two dissociate constantly:

- *Large footprint, low decision-content:* a 12-file mechanical rename. No fork, fully reversible, obvious "how." → **low complexity** despite the file count.
- *Tiny footprint, high decision-content:* a one-line change that silently resolves an undecided fork (where does this live? who owns this id? what ordering?). → **high complexity** despite touching almost nothing. **Small footprint ≠ small decision.**

What *actually* raises complexity (read these, not the line count):

- **Actors / seams** — how many independent parts must agree across an interface.
- **Reversibility / blast radius** — how bad it is, and how hard to undo, if it's wrong.
- **Volatility** — how likely the thing is to change again soon.
- **Hidden coupling** — effects that reach beyond the files in the diff.
- **Undecided forks** — any choice the spec/plan never made that the work would make by default.

Score complexity from *these*, then let footprint adjust the dispatch *tax* — not the floor.

## 3. The hardest-signal rule, generalized

Signals are **not equal votes.** The floor is the **highest** shape any single signal justifies — **never the average.** You then bias *down* only within what every signal allows.

Worked: **low scope (1 file) + high irreversibility (a destructive migration) → escalate.** Footprint says one-shot; irreversibility says gate. Irreversibility wins; you add the gate. Averaging the two would land on "medium, just do it" — and ship the dangerous thing with no stop.

Why **averaging is *the* characteristic failure:** most signals on most tasks are cheap, so a cheap majority will always outvote the one decisive risk. Averaging is precisely the mechanism by which a real unknown, an irreversible step, or an undecided fork gets *drowned out* by an otherwise-easy task. The whole point of the rule is that one severe signal is not negotiable against three mild ones.

## 4. Senior trade-off thinking

- **One-way vs. two-way doors.** Reversible (two-way) decisions: move fast, decide at the floor, fix mid-flight if wrong. Irreversible (one-way) decisions — migrations, deletions, external writes, published contracts — **gate them**, regardless of footprint. Match the ceremony to the door, not the diff.
- **Cost-of-being-wrong vs. cost-of-process — and the trap between them.** Under-routing is **cheap and recoverable** (escalate mid-flight, re-enter at the smallest sufficient node). Over-routing is **sunk, visible waste** (a plan nobody needed). That asymmetry is the bias-to-the-floor. **But there is a third cost that beats both: guessing an undecided fork is expensive *and silent* — it ships fragile and no gate ever caught it.** So bias to the floor against *process* waste, but never against *surfacing a fork.* Cheap-to-recover beats sunk waste; both beat a silent guess.
- **"Good enough" beats "correct"** when the gap is reversible and low-blast. Don't gold-plate a two-way door. Do not invoke this to skip a gate on a one-way door.
- **Sequence the riskiest/most-uncertain decision *first*.** Resolve the fork or unknown that could *invalidate finished work* before you build the work. Deferring it to last means a late answer can wipe out everything built on the guess. Fail cheap, fail early.
- **The bias is symmetric.** Over-routing a one-liner is one failure; one-shotting a hidden design choice — guess, ship, fragile — is the equal-and-opposite one. Hold both. The floor is a floor, not a ceiling, and not a license to skip.

## 5. Worked examples (prompt → lens → floor)

- *"The date formatter drops the timezone — fix it."* Known how, one symbol, reversible, no fork. → **one-shot.** Writing a plan here is the over-routing failure.
- *"Emit events to a log."* Reads as ~2 files (low footprint). But *where the log lives* and *how a per-call hook learns the active context-id* is an **undecided fork** (decision-content + an identity/routing unknown). Hardest signal vetoes the floor. → **spec-first → plan gate**, and the fork is visible up front, so escalate *before* touching code.
- *"Add pagination across the API, service, and data layers."* Multi-actor, clean seams between layers, each independently verifiable, no single dominating unknown. → **decompose+verify** — slice contracts per seam.
- *"I heard our bundler can't tree-shake this package — is that still true?"* A single, recency-sensitive, unverified claim that would steer the build. The bet test fails. → **research first**, then route on the finding.
- *"Rename `Foo` to `Bar` across 12 files."* Large footprint, zero decision-content, reversible. → **one-shot (or a single mechanical task)** — don't let the file count inflate the floor.

## 6. Self-catch — name the failure when you feel it

- **Averaging signals** — letting a cheap majority outvote one decisive risk. The floor is the *max*, not the mean.
- **Footprint-as-complexity** — sizing by files touched instead of forks decided. Small footprint ≠ small decision.
- **Guessing an unknown because researching feels slow** — the silent, expensive failure. Surface or research it; don't bet the build on a shrug.
- **Over-routing a one-liner** — spec/plan ceremony on a reversible floor task. Visible waste.
- **Deferring the riskiest decision to last** — letting a late answer invalidate finished work. Sequence the uncertain step first.
- **Treating a one-way door like a two-way one** — skipping the gate on something you can't undo.

See `routing-and-dispatch.md` for how the floor you set here becomes a dispatch shape, the escalation triggers, and the gating points.
