# 08 — Self-Eval: Measuring Agentry to Improve Agentry (instrument + system)

> **Status:** Living · **Date:** 2026-06-15 (instrument) · 2026-06-16 (system architecture + corrections)
> · **Scope:** the reframed self-eval — the **instrument** (measure Agentry's own judgment so we can tune
> it against a number, not a vibe), the **system** it must become (a persistence-first runner + artifact
> store + events + results + reporter + the Self-Eval Workbench, §5), and the dashboard that visualizes it
> (§6). Sequenced **before** the Workbench (doc 10) because the self-eval is the regression gate the
> Workbench and everything after it should be measured against. Supersedes the headline purpose of doc 06.
> Governing authorities: reframe decision `p:01KV4QTADVHFRP1WE8GMZC0S9X`, eval-methodology memory
> `g:01KV4QTQ42C2BX1MY76Z80AJ74`. Packaging (what ships vs. dev-only) → doc 09.

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
wrong and the conductor was better than measured** — *every single time*, in the same direction:

| # | Reported | The flaw the instrument caught | True picture |
| :-- | :-- | :-- | :-- |
| 1 | 28.6% | dispatch-proxy + empty sandbox confounds | invalid |
| 2 | 42.9% | empty-sandbox (multi-layer tasks collapse) | de-confounded by seeds |
| 3 | 42.9% | rubric tuning had zero *measured* effect | tuning was invisible to a broken proxy |
| 4 | 71.4% | dispatch-proxy invalid: escalation-via-gate scored one-shot | fixed by artifact extraction |
| 5 | 85.7% (of 7) | pagination *mislabeled* decompose (conductor was right) | honest re-label, conductor vindicated |
| 6 | — | notifications is a routing *coin-flip*, not a gap | motivated multi-run variance |
| 7 | 76.7% (of 30) | 5 decompose→one-shot were a **cap-timing** artifact (180s cap killed slow planners) | artifact-aware terminate → **80%** |
| 8 | 80.0% (of 30) | remaining decompose→spec-first partly a **45s grace-window** artifact | decompose true accuracy ≥ measured |

Current best honest reading: **80.0% (24/30), single roll** — one-shot 10/10, spec-first 10/10, decompose
4/10-and-likely-higher; controls passed; all errors one direction (under-route on decompose).

**This timeline is the product.** A number can be faked; a public record of an instrument catching itself
being wrong, repeatedly, and correcting in the open, is uncopyable trust.

## 5. The self-eval as a *system* (persistence-first — the level-up)

The instrument works, but it grew as throwaway scripts: each run is an ad-hoc `.ts` file that captures only
what that moment needs, then the data evaporates with the temp sandbox — so re-analysis (e.g. the quality
gate over the routing under-routes) has to **re-run the conductor and re-spend the tokens.** The fix is one
principle: **capture once, persist everything, analyze many times.** That single move converts scripts into
a system; everything else falls out of it.

| Component | What it is | Replaces |
| :-- | :-- | :-- |
| **Runner / CLI** | one entrypoint, subcommands (`run routing`, `run quality`, `trace <task>`, `replay <run>`) — config-driven | the throwaway `diag-*.ts` / `quality-gate.ts` files |
| **Artifact store** | every run writes a gitignored `runs/<timestamp>/`: per-task stream, captured spec/plan, extracted shape, timings | re-running the conductor to re-capture |
| **Events stream** | per-task `events.jsonl` + stdout (`task 12/30: webhooks → decompose ✓`) | the *silent* run with no progress signal |
| **Results** | committed `results/<date>/` = summary JSONs + chart data (no raw streams) | nothing public/durable today |
| **Reporter** | turns `results/` into charts / markdown / SVG (corrections timeline, confusion matrix, quality) | hand-built one-off images |
| **Self-Eval Workbench** | a web UI reading `events.jsonl` (live) + `results/` (history): real-time progress, results, drill-down | watching a 50-min run blind |

> **The keystone is the artifact store.** Once every run persists its full trace, *progress* is reading the
> events file, the *quality gate* reads stored specs (no re-run), *charts* read results, the *UI* reads
> both. The token bleed from reconstructing state we already had disappears.

This is a **distinct workbench** from the *Agentry* Workbench (doc 10) — that one reviews a build's
artifacts; this one observes the self-eval. Build the store + events + runner first (they unblock
everything); the reporter and UI ride on top once the data model stabilizes. Where this code *lives* (it
must NOT ship in the plugin) is doc 09.

## 6. The Dashboard (the visualization & regression surface)

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

## 7. Open work (the honest backlog)

**The system build (§5) — do first; it unblocks the rest:**
- **Artifact store + events + runner** — persistence-first; one CLI, no more throwaway scripts; per-task
  progress logging (the silent 50-min run is the felt pain). Then the quality gate reads stored specs
  instead of re-running.
- **Reporter → charts**, then the **Self-Eval Workbench** UI (once the data model stabilizes).
- **Packaging** — move the eval out of the shipped plugin payload (doc 09).

**The measurement itself:**
- **Bump the grace window** 45s → ~90–120s before the next run (the 80% still under-credits decompose —
  slow planners write `plan.md` >45s after `spec.md` and get cut to spec-first). Better: terminate on an
  explicit "decompose decided" signal, not a timer.
- **k=3 variance run** (uninterrupted) → the number with error bars + per-task stability.
- **Quality-weighted routing** — run the quality gate over the routing under-routes: a shape-mismatch only
  counts as a failure if the *output quality* suffered. Tests whether "decompose→spec-first" is a defensible
  right-size or a real gap. (First live use of the quality judge; validates the judge too.)
- **Held-out vs training** breakout; **proxy-validation** (sample to completion → does plan-quality predict
  outcome-success? — don't *assume* good plans ⇒ success).
- **Decompose-recognition consistency** tune (generic; don't over-decompose coupled layers).
- **Config hook** — productize `AGENTRY_AUTOPILOT` (SessionStart, dep-free) to replace the prompt-injection.
- **Grow + power** — toward ~50 tasks with CIs when a public claim needs the statistical power.
- **Then the dashboard.**
