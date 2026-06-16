# 11 — Self-Eval & the Dashboard: Measuring Agentry to Improve Agentry

> **Status:** Living · **Date:** 2026-06-15 · **Scope:** the reframed self-eval instrument (measure
> Agentry's own judgment so we can tune it against a number, not a vibe) and the HTML dashboard that
> visualizes it. Supersedes the headline purpose of doc 06 (now one experiment among many — see its
> 2026-06-15 re-point note). Governing authorities: reframe decision `p:01KV4QTADVHFRP1WE8GMZC0S9X`,
> eval-methodology memory `g:01KV4QTQ42C2BX1MY76Z80AJ74`.

---

## 0. The stance (unchanged from doc 06, re-aimed)

Define falsifiable win-conditions up front; **measure the mechanism, not a proxy**; publish the real
numbers including the unflattering ones; and gate every number behind controls that *could* falsify it.
The reframe: stop proving "Agentry beats raw Claude" (ceiling effect, moat didn't fire) — instead
**benchmark Agentry to improve Agentry** across tunable dimensions, each mapping to durable content we can
sharpen.

## 1. The five dimensions (only ROUTING + QUALITY are built)

| Dimension | Tunes | Probe | Status |
| :--- | :--- | :--- | :--- |
| **Routing accuracy** | conducting routing rubric | label task → run through autopilot → read shape from work-folder artifacts → compare to floor | **built** (`selfeval/src/routing/`) |
| **Decision quality** | conducting judgment (the "smartness") | LLM-judge scores the spec/plan the conductor produced on 5 rubric dims | **built** (`selfeval/src/quality/`) |
| Gate efficacy | conducting gate triggers | plant an undecided fork; did it gate/record or guess | future |
| Verifier catch-rate | reviewing prompt | plant N bugs; how many caught | future |
| Memory hygiene | remembering / recall | does recall surface the seeded fact | future |

## 2. The routing probe — how it actually measures (and the seams it took to get right)

Each labeled task runs through the **real conductor** (`/agentry:go`, plugin loaded, in **auto-pilot
mode** so it never blocks headless), in an isolated sandbox **seeded with a realistic starting codebase**
so the task's premise holds. The dispatched **shape is read from the conductor's work-folder artifacts**
(`.agentry/work/<id>/`: `plan.md`|`tasks/` → decompose · `spec.md` → spec-first · none + clean settle →
one-shot) — *not* the subagent-dispatch pattern (a proven-invalid proxy). Controls gate the score:
A/A unanimity (negative), planted positive, saturation guard, all **before** any accuracy number.
**Multi-run variance** (`--runs k`) runs each task k times and reports a per-run accuracy distribution +
per-task **stability** + a `noisyTasks` list — because routing is per-task *stochastic*.

Key resolved design decisions live in `.agentry/work/benchmark-selfeval/` (spec, plan-v2, autopilot-design,
quality-eval-design) and in repo memory.

## 3. Auto-pilot mode (the enabler — `skills/conducting/`)

An opt-in **interaction mode** (`AGENTRY_AUTOPILOT=1`): the conductor does the **same** routing/spec/plan/
split work but **never blocks at a gate** — it decides the best option, **records it as a work-folder
artifact** (with the assumption + a one-line override hint), and proceeds. *Autonomous AND accountable;*
the full process remains, only the human-wait is removed. This is what makes Agentry measurable headlessly
**and** is a real product capability (CI/batch). Note: env-var detection alone is unreliable (the model
won't self-`printenv`); the benchmark injects the directive, and a SessionStart **config hook** is the
queued productized trigger.

## 4. The corrections log — the honesty record (this IS the differentiator)

Every routing number the instrument first reported was *wrong*, and looking closer showed **the meter was
wrong and the conductor was better than measured** — five times running:

| # | Reported | The flaw the instrument caught | True picture |
| :-- | :-- | :-- | :-- |
| 1 | 28.6% | dispatch-proxy + empty sandbox confounds | invalid |
| 2 | 42.9% | empty-sandbox (multi-layer tasks collapse) | de-confounded by seeds |
| 3 | 42.9% | rubric tuning had zero measured effect | tuning was invisible to a broken proxy |
| 4 | 71.4% | dispatch-proxy invalid: escalation-via-gate scores one-shot | fixed by artifact extraction |
| 5 | 85.7% | pagination *mislabeled* decompose (conductor was right) | honest re-label, conductor vindicated |
| — | ~86–100% | notifications is a routing *coin-flip*, not a gap | motivated multi-run variance |

**This timeline is the product.** A number can be faked; a public record of an instrument catching itself
being wrong, repeatedly, and correcting in the open, is uncopyable trust.

## 5. The Dashboard (future — the visualization & regression surface)

A self-contained **static HTML** generated from the eval artifact JSONs (`routing-accuracy.json`,
quality scores, run history). Reproducible: *"run the eval, get this page."*

**Design principle — a TRUST dashboard, not a vanity scoreboard.** Do **not** hero the accuracy %. Lead
with the honesty machinery:
- **Control panel** — A/A, saturation, planted-discrimination verdicts; goes **red** when a gate fires
  (the instrument visibly refusing a flattering number).
- **Corrections log** (§4) — the run-over-run timeline annotated with *why* each number moved.
- **Held-out vs training** split — the never-tuned-against number, badged.
- Headline numbers **with CI** (from k-runs) — routing accuracy + decision-quality mean.
- Interactive **confusion matrix**; per-task drill-down (seed → produced spec/plan → quality dimensions →
  stability, with `noisyTasks` flagged).

**When:** *after the data stabilizes* (k=3 number, quality scores, held-out breakout). A dashboard over a
still-moving instrument polishes a number that's still changing.

**Where it goes:**
1. **Unified self-eval surface** — routing + quality today; the other three dimensions drop into the same
   page as they're built.
2. **Regression gate** — run the eval on every conducting-skill change; the dashboard shows whether
   routing/quality *regressed*. This turns the eval from "a number we report" into "the thing that stops
   us shipping a worse Agentry" — the moat the whole project is about.

**Build shape:** `frontend-design` / `ckm-design` skills; the `session-report` skill (explorable HTML from
JSON) is a direct precedent.

## 6. Open work (the honest backlog)

- **k=3 variance run** on the 30-task set → the number with error bars + per-task stability.
- **Live-validate the quality judge** (planted gold/poor discrimination on the real judge) + point it at
  the conductor's real artifacts; **held-out vs training** breakout in the artifact.
- **Decompose-recognition consistency** — the conductor decomposes a genuinely-separable feature only
  ~half the time; sharpen the spec-first↔decompose boundary *generically* (without over-decomposing
  coupled layers like pagination). Quantify with the variance run first.
- **Config hook** — productize the `AGENTRY_AUTOPILOT` trigger (SessionStart, dep-free) so the real
  mechanism replaces the benchmark's prompt-injection.
- **Grow further + power** — toward ~50 tasks with CIs if/when a public claim needs the statistical power.
- **Then the dashboard.**
