# `@agentry/eval` — Agentry's self-eval

A dev-only instrument that measures whether Agentry does what it claims — on its own real work, behind
controls that run **before any score is shown**. It's the "show the receipts" layer: measured, not asserted.

## What it measures — and what it doesn't

Agentry is a **precision** layer, not a capability multiplier. It doesn't make the underlying model smarter,
so the honest question isn't "does Agentry beat a bare model on outcome?" — across short, wide, and
deliberately trap-laden tasks, **a bare modern model already aces anything that fits one context, so the
outcome lift is ≈0 by design.** A harness can't add outcome where there's no gap.

What it *can* add — and what this eval measures — is precision:

- **Right-sizing** — does the conductor route to the least process that wins (one-shot / spec-first /
  decompose), without over- or under-processing?
- **Spec-adherence** — does the conducted work actually pass its acceptance, judged by a **hidden held-out
  oracle**, never the agent's self-report?
- **Honesty** — does it ever claim "done" when an oracle says it failed? (the overclaim gap)
- **Process reliability** — when it escalates, does it follow its own process (open a run, record the routing
  decision, write well-formed artifacts)?

A routing "miss" against a label only counts if the **outcome** suffered: an under-route that still ships
passing work isn't an error — it's the floor being lighter than the label assumed.

## The probes (`src/<probe>/`)

The public bench is **three probes**, each built to one uniform five-stage shape (`fixture → probe → artifact →
controls → report-section`, ADR-002) so adding a fourth is mechanical:

| Probe | Question | `run` subcommand |
|---|---|---|
| `moat` | Does a recalled gotcha prevent a re-bug (memory hygiene)? | `run moat` |
| `rightsizing` | Did the conductor route to the least process that *wins* (results-gated, not label-match)? | `run rightsizing` |
| `honesty` | Did it ever claim "done" below the oracle bar (overclaim gap), and did escalated runs follow the process (flow-compliance)? | (rides the same conduct as `run rightsizing`) |

`run rightsizing` is the **unified conduct-and-judge** harness (ADR-001): it conducts each task **once**, reads the
routed shape from the settled work-folder artifacts **and** judges the produced tree, then scores results-gated
(`right-sizing-success` / `over-route-tax` / `under-route-failure`, with `indeterminate` as its own terminal
category — never a bare label-match accuracy). The **honesty** probe rides that same conduct: it is two pure reads
over the same per-run records (the overclaim gap) plus a read-only flow-compliance census, so it never re-conducts.
The CLI persists the rightsizing artifact in `summary.json` and writes the honesty artifact as a sibling
`honesty.json` in the same run dir.

The bench is **Agentry-value-only** (ADR-003): the old bare baseline is retired — there is no bare-vs-Agentry
delta on the public path. The decision-quality 0–2 rubric (`src/quality/`) is **parked**: it stays as a dev
instrument (code + tests kept) but is off the public subcommand set and the public report.

## Methodology (the spine)

- **Controls gate every run.** A/A reproducibility, planted gold↔poor discrimination, and a saturation guard
  run *first*; if a gate fails, no score is emitted (a misaimed eval is structurally impossible).
- **Hidden oracles.** Outcome fixtures ship a held-out test suite the agent never sees; it's injected into the
  sandbox and run *after* the agent finishes. "Done" is the oracle's verdict, not the agent's.
- **Read artifacts, not the stream.** Routing/compliance are read from the conductor's work-folder artifacts
  (`.agentry/work/<run>/`), not a dispatch proxy — so there's no grade signal to leak in.
- **Early-signal honesty.** Report N, k, and spread; never a bare point estimate. Small N is directional.

### How Agentry is invoked headless (important)

`claude -p "/agentry:go <task>"` is a **0-turn no-op** in print mode — the slash command expands and the
process exits without ever running the model. So the eval delivers the *expanded* `go.md` conductor prompt as
plain text instead (see `src/conductor-prompt.ts`). Anything that runs Agentry headless must do the same, or
it measures a conductor that never ran.

## Develop

```sh
pnpm --filter @agentry/eval typecheck   # tsc --noEmit
pnpm --filter @agentry/eval test        # node --import tsx --test  (zero API — fake child / replay runners)

# a live run (spends API): drive the unified rightsizing+honesty conduct through real `claude -p`
node --import tsx src/cli.ts run rightsizing --fixtures-dir fixtures/rightsizing \
  --plugin-dir <repo-root> --model sonnet --runs 3 --concurrency 4 --run-id <id>

# then render the static dashboard for a stored run (zero API), or re-derive its shapes offline
node --import tsx src/cli.ts report <id>
node --import tsx src/cli.ts replay <id>
```

Tests never spend API — they drive the probes through replay/fake runners. Live runs are isolated per task in
a temp sandbox; `--concurrency N` batches independent runs (keep it modest, ~3–4: Agentry cells spawn
subagents, so a high limit hits API rate limits). No build / bundle / `dist` — run via `tsx`.
