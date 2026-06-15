# 06 — The Benchmark: The Proof

> **Status:** Locked (iteration 1) · **Date:** 2026-06-13 · **Scope:** how we *prove* Agentry beats a
> plain Claude Code session — honestly, headlessly, reproducibly. Win-conditions defined **up front** so
> we can't move the goalposts. This is the doc that fixes the v1 disappointment: v1 shipped but never
> *proved* the moat (the headless moat measurement was left unsolved, #40).

> **Re-pointed (2026-06-15):** Under the reframed self-improvement purpose — *measure Agentry to tune
> Agentry* — this plain/cold/warm benchmark is **demoted to one experiment** of many, not the headline.
> Its C1–C4 / moat framing below stands as the design-of-record for that experiment. See reframe decision
> `p:01KV4QTADVHFRP1WE8GMZC0S9X` and `.agentry/work/benchmark-selfeval/spec.md`.

---

## 0. The stance

> Define the win-conditions **before** building, make them **falsifiable**, and publish the actual
> numbers — **including a documented "no win in regime R"** if that's what we measure. You build *toward
> a number*, not toward a vibe.

Same model + same settings across every arm. Only **the layer** differs. Anything else is a confound.

---

## 1. The two claims → four regimes

| | Claim | Regime |
| :--- | :--- | :--- |
| **Orchestration** | beats a plain session where one context degrades | **R1 multi-file**, **R2 under-specified** |
| (no tax) | routes trivial work one-shot — *no orchestration cost* | **R0 trivial / well-specified** |
| **Memory (moat)** | the *second* time, warm-store, it's faster/better | **R3 warm-store** |

R0 is as important as R1/R2: over-orchestrating a one-liner is a **failure to surface**, not a feature.

---

## 1a. The parity trap — measure edges, not averages

Same model → on an **average** task, a plain session and Agentry produce roughly equal output.
**Benchmarking average quality would measure parity and falsely conclude "no value."** Agentry's claim
was never "better on everything" — it's four *specific* edges, each exposed by a regime and measured by a
metric that **surfaces the edge instead of averaging it away**:

| Edge | Regime | Metric (where they are NOT equal) |
| :--- | :--- | :--- |
| separate verifier (no self-grading) | **R1′ bug-seeded** tasks | **escaped-defect rate** — defects shipped that a hidden suite catches |
| spec gate (clarify "done=X") | **R2 under-specified** (hidden AC set) | **requirement coverage** — hidden ACs met (plain under-delivers on vague) |
| **the moat** (recall precedent/gotchas) | **R3 warm vs cold** follow-up | tokens · iterations · a prior gotcha demonstrably avoided |
| right-sizing (negative claim) | **R0 trivial** | overhead ≤ X% — must *not* tax the trivial |

**Lead with the moat — it is the only *categorical* edge.** A plain session **structurally cannot**
recall a prior run's gotcha; Agentry can, so R3 parity is impossible by construction. The other three are
**probabilistic** — a plain session *sometimes* also catches the bug or meets the vague AC — so they show
as a **rate difference over N runs**, not a guaranteed per-task win. Choose `N` and tasks accordingly,
and never average over R0-style tasks where parity is the expected, correct outcome.

---

## 2. The arms

- **A — plain** : `claude -p "<task>"` (baseline, no Agentry).
- **B — agentry-cold** : `claude -p "/agentry <task>"`, memory store **empty**.
- **C — agentry-warm** : same, memory store **pre-warmed** by a prior related run (R3 only).

---

## 3. Metrics (objective primary, soft secondary)

| Metric | How | Role |
| :--- | :--- | :--- |
| **AC pass-rate** | run the task's **hidden acceptance suite** (tests / observed behavior) | the objective *substrate* (`assemble` vs Spec ACs) — but on R0/average tasks it's **parity**, so it proves little alone |
| **Escaped-defect rate** | hidden suite catches a **seeded/subtle bug** the run shipped (R1′) | **edge metric** — the separate-verifier value; Agentry should escape fewer |
| **Requirement coverage** | of the **hidden** AC set on an under-specified ask (R2) | **edge metric** — the spec-gate value; plain under-delivers on vague |
| **Warm − cold delta** | arm C vs arm B on the R3 follow-up | **edge metric — the moat (categorical)** |
| **Cost** | tokens · turns · wall-clock from `--output-format json` usage | objective — counts *all* subagent/conductor overhead, honestly |
| **Code quality** | static (file length, complexity, lint) + an LLM-judge panel (multi-judge, variance) | secondary, softer — never the sole basis of a verdict |

**The edge metrics — not average AC-pass — are what prove the thesis.** Averaging AC-pass across mixed
tasks washes out to parity (your skepticism, correct). Report each edge metric **per regime, as a rate
over N runs** with variance; the warm−cold delta is the one that can't tie.

---

## 4. Win-conditions C1–C4 (falsifiable; thresholds are targets, calibrated by the first run)

- **C1 — no tax (R0):** Agentry AC-pass ≥ plain **and** token overhead ≤ **X%**. *Proves it routes
  one-shot and pays no orchestration tax.* Failure = over-orchestration, surfaced loudly.
- **C2 — fewer escaped defects (R1′):** on bug-seeded multi-file tasks, Agentry's **escaped-defect rate is
  lower than plain's by ≥ Y** (the separate verifier catches what self-grading ships). A *rate over N*, not a per-task win.
- **C3 — fewer missed requirements (R2):** Agentry meets ≥ **Z** more *hidden* ACs than plain on
  under-specified asks (plain under-delivers on vague goals).
- **C4 — the moat (R3) [categorical]:** **warm (C)** beats **cold (B)** on the *same* follow-up — ≥ **W%**
  fewer tokens/iterations **and/or** a run-#1 gotcha demonstrably avoided. Parity is impossible here by
  construction (plain can't recall), so this is the proof to land first.

`X / Y / Z / W` are written as **targets up front**, then set by the first measured run. The scoreboard
reports the real deltas regardless.

---

## 5. The moat experiment — the part v1 never solved

The moat must be **isolated**, not asserted. Mechanism: a **controlled cold-vs-warm pair on a follow-up
task**, where the *only* variable is memory state.

```
run #1 (teacher)  →  builds something, hits a gotcha, makes decisions, maps the repo
                          │ (memory store now holds episodes + facts)
run #2 (follow-up, RELATED work):
   arm B  agentry-cold  → store wiped     ── baseline
   arm C  agentry-warm  → store from #1   ── treatment
   Δ(C, B)  =  the moat                    (tokens · turns · ACs · gotcha-avoided)
```

Same task, same harness, same model — **only memory differs.** If `Δ` is null, we publish *"no
measurable moat in regime R3"* honestly. Task **pairs** ship with: the teacher task, the related
follow-up, and **the specific lesson** the follow-up should reuse (a recalled gotcha, a reused decision,
a warm context map).

---

## 6. Harness mechanics (headless + reproducible)

- **Fixture per task:** prompt · regime label · **hidden** acceptance suite (not in the prompt → can't be
  gamed) · for R3: the paired follow-up + the lesson it should reuse.
- **Runner:** fresh sandbox per run (clean dir/repo, no leakage) → `claude -p` with the arm's invocation →
  capture diff + `--output-format json` usage → run the acceptance suite → record AC-pass · tokens ·
  turns · wall-clock.
- **Variance:** the model is stochastic → **N repeats per cell**, report **mean + variance**, never a
  single run. (v1's "72 routing decisions" shows the bar for sample size.)
- **Scoreboard:** per-regime table + the C1–C4 verdicts with deltas + confidence. Lives in `benchmark/`.

---

## 7. Credibility controls (kill the confounds)

- Identical model + settings across arms; only the layer differs.
- Fresh sandbox per run; hidden acceptance suites; sufficient N.
- **Orchestration overhead counted in full** — every subagent + conductor token is in the cost. No hiding
  the tax.
- Moat arm: cold vs warm differ in **memory only** — nothing else.
- The benchmark **reuses Agentry's own machinery** (Spec ACs as the grader, `assemble` as the grading
  step) — building the benchmark and building `assemble`/Spec reinforce each other.

---

## 8. The task suite (regime-labeled; expandable)

Real buildable tasks across regimes (seed set, grows over time):

- **R0 trivial:** one-line fix · single-function add · a typo/rename. (parity expected — guards the no-tax claim)
- **R1 multi-file:** a feature across several modules (e.g. paginate an endpoint end-to-end).
- **R1′ bug-seeded:** a task whose correct solution must avoid a subtle bug/edge case the hidden suite
  probes — exposes the separate-verifier edge (escaped-defect rate).
- **R2 under-specified:** a vague goal ("make X better") with a *hidden* AC set the ideal solution meets.
- **R3 pairs:** teacher + related follow-up (e.g. build module A → extend A; first run learns a gotcha
  the second should recall) + the specific lesson the follow-up should reuse.

Each task is small enough to run many times cheaply, real enough that structure + memory can matter.

---

## 9. Open / to-calibrate

| Knob | Set by |
| :--- | :--- |
| `X / Y / Z / W` thresholds | the first measured run (targets now, numbers then) |
| `N` repeats per cell | variance observed vs budget |
| LLM-judge reliability | inter-judge agreement on a labeled sample |
| task-suite coverage | gaps found once regimes run |

**North-star:** C2 + C3 (orchestration) and C4 (moat) clear their targets; C1 confirms no tax.

---

## 10. Closed vs deferred

**Closed:** the stance · the four regimes · the three arms · metrics (AC-pass primary) · **C1–C4
falsifiable win-conditions** · the **controlled cold-vs-warm moat experiment** (the v1 gap, solved at the
design level) · harness mechanics · credibility controls · the regime-labeled task suite.

**Deferred — and build the harness LAST, on purpose.** Benchmarking an immature harness measures its
immaturity, not the design (we've found ~6 conductor/skill gaps in early dogfooding alone). So:
**dogfood real tasks until the conductor + skills stabilize**, *then* build `benchmark/` and run the
first calibration pass. Cheap interim signal: a **manual duel** (one bug-seeded task run plain vs
`/agentry:go`, compare escaped defects) — no harness needed. The automated harness is the last step, not
the next.

---

_Signed-off (iteration 1): the proof is specified — falsifiable C1–C4, and a controlled experiment that
isolates the moat headlessly (the thing v1 never measured). Build toward the number._
