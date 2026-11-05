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

## The bench (`src/bench/`)

There is **one** subcommand that conducts Agentry: `run bench`. It conducts each fixture in `fixtures/bench/` **once**
through the expanded `/agentry:go` prompt, then derives every value axis from that single run:

| Axis | Question |
|---|---|
| Decision quality | Did the conductor surface the fork the task hides, and record its assumption and override hint? (judged 0–2 against a rubric that is gated by planted gold/poor controls) |
| Code correctness | Does the produced tree pass the **hidden held-out oracle**, and how is it judged on soundness and completeness? |
| Honesty | Did it ever claim "done" below the oracle bar (the overclaim gap)? |
| Escaped defects | On fixtures whose obvious solution hides a subtle bug, did that bug ship? |

The shape the conductor routed to (one-shot / spec-first / decompose) is read from the settled work-folder
artifacts, never from a dispatch proxy. The other subcommands are zero-API: `replay <id>` re-derives shapes from a
stored run and `report <id>` renders its dashboard. A read-only flow-compliance probe
(`src/honesty/flow-compliance/`) exists for a captured run dir, but no CLI subcommand runs it today.

The bench is **Agentry-value-only**: the old bare baseline is retired — there is no bare-vs-Agentry
delta on the public path.

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
```

A live run (spends API). **It runs `claude -p` with `bypassPermissions` on your own machine** — the conducted model
can read, write and run commands without asking; each task gets a fresh temp directory, but the process is not
otherwise sandboxed. Only run it where you are comfortable with that.

```sh
pnpm --filter @agentry/core build   # once: @agentry/eval imports the built contract
pnpm --filter @agentry/eval selfeval run bench --fixtures-dir fixtures/bench \
  --plugin-dir ../.. --model sonnet --k 3 --concurrency 3 --budget-usd 20 --run-id <id>

# then render the static dashboard for a stored run (zero API), or re-derive its shapes offline
pnpm --filter @agentry/eval selfeval report <id>
pnpm --filter @agentry/eval selfeval replay <id>
```

`--plugin-dir` is the Agentry **repo root**; the runner reads `plugin/commands/go.md` from it and starts `claude`
with `--plugin-dir <repo-root>/plugin`, and a root with no `plugin/.claude-plugin/plugin.json` is refused.
`--k`, `--concurrency` and `--timeout` (ms) must be whole numbers >= 1, or the command exits 2.

Bench results recorded before this fix ran **without** the Agentry plugin (`claude` was given the repo root rather
than `plugin/`), so treat them as unmeasured.

Tests never spend API — they drive the probes through fake runners (one test puts a fake `claude` on `PATH` and
records its argv). Live runs are isolated per task in a temp sandbox; `--concurrency N` batches independent runs
(keep it modest, ~3–4: Agentry cells spawn subagents, so a high limit hits API rate limits). No build / bundle /
`dist` — run via `tsx`.
