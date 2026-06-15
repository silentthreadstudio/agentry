# `@agentry/benchmark` — the Agentry benchmark harness

A headless instrument that runs a task **suite** across three experiment **arms**, repeats each cell **N**
times, grades the produced work deterministically, and emits a single source-of-truth `scoreboard.json` with
the C1–C4 win-condition verdicts, a per-regime breakdown, and the R3 moat section.

This package **measures**; it does not tune. It is dev-only and runs via `tsx` (never bundled). It spends real
API credit only when run with the **live** Runner — the **replay** Runner reproduces the whole pipeline with
zero spend (used by the tests and the smoke check).

## The single command

```sh
node benchmark/src/cli.ts --suite <dir> --arms A,B,C --n <N> [--seed <s>] [--runner live|replay] \
                          [--out <scoreboard.json>] [--md <scoreboard.md>] [--replay-fixture <path>]
```

It is fully **headless**: no TTY prompt, exits `0` on success, and writes the artifact to disk. `stdout` carries
only the artifact path (script-friendly); progress and the planned-spend announcement go to `stderr`.

### Flags

| Flag | Required | Default | Meaning |
| --- | --- | --- | --- |
| `--suite <dir>` | yes | — | Path to the task suite. Each immediate subdir with a `task.yaml` is one task; its sibling `grader/` is the hidden suite (never shown to the agent). |
| `--arms <list>` | no | `A,B,C` | Comma-separated arms: `A` = plain (no Agentry), `B` = cold (Agentry, empty memory), `C` = warm (Agentry, seeded memory). Deduped and run in canonical `A,B,C` order. |
| `--n <N>` | no | `10` | Repeats per `(regime × arm)` cell. Needs `≥ 2` for a defined variance. |
| `--seed <s>` | no | `1` | Deterministic seed for **task ordering/sampling** and the bootstrap PRNG. It does **not** touch model output — the model's run-to-run noise is what the instrument measures. Same config + seed ⇒ identical C1–C4 verdicts. |
| `--runner <kind>` | no | `live` | `live` spends API via `claude -p`; `replay` spends nothing (returns a recorded result). |
| `--out <path>` | no | `scoreboard.json` | Where to write the JSON artifact. |
| `--md <path>` | no | — | Also write a flat Markdown projection of the scoreboard. |
| `--replay-fixture <path>` | no | built-in empty record | With `--runner replay`, replay this recorded `RunRecord` JSON for every run. Omitted ⇒ a built-in zero-spend record (empty produced tree). |

### Config knobs (the same surface, programmatically)

`resolveConfig({ suitePath, arms?, n?, seed?, cells? })` normalizes a partial config: `arms` defaults to all
three, `n` to `10`, `seed` to `1`. `cells` optionally pins an explicit `(regime × arm)` selection; when absent
the matrix is built from the loaded suite (every regime present × every eligible arm).

The pinned model is discovered from the environment (`AGENTRY_BENCH_MODEL`, falling back to a default model id)
so it is held constant across arms (the confound rule). The repo root the Agentry plugin loads from (arms B/C)
is discovered from `AGENTRY_REPO_DIR`, else from the package location — nothing repo-specific is hard-coded.

## What it produces

`scoreboard.json` (the source of truth) carries:

- **`claims` (C1–C4)** — each a `{ verdict, delta, variance }`. The verdict is an honest win/null: a win needs
  the bootstrap CI to exclude 0 **and** clear a minimum effect size; otherwise it reads `null` ("no measurable
  win"). The four claims map to:
  - **C1 (R0):** cold (B) vs plain (A) AC-pass-rate — no orchestration tax.
  - **C2 (R1′):** cold (B) vs plain (A) AC-pass-rate — fewer escaped defects.
  - **C3 (R2):** cold (B) vs plain (A) AC-pass-rate — fewer missed requirements.
  - **C4 (R3):** warm (C) vs cold (B) AC-pass-rate on the same follow-up — the moat.
- **`perRegime`** — one row per regime present, with mean AC-pass-rate per arm (plus tokens/turns per arm for R3).
- **`r3`** — each teacher→follow-up pair's cold/warm summary, the C−B moat delta, and the lesson-reuse signal.
- **`r2Coverage`** — R2 hidden-AC coverage as `met/total` per arm (a count, never a boolean).

`--md` renders a flat Markdown projection of exactly that JSON (a pure function of it — never an authored doc).

## Headless smoke (zero API spend)

```sh
node benchmark/src/cli.ts --suite benchmark/fixtures --arms A,B,C --n 2 --runner replay < /dev/null \
  && echo "exit 0, no TTY"
```

This drives every layer against the built-in replay record (empty produced tree ⇒ honest-null verdicts by
construction) and writes `scoreboard.json` — proving the command runs non-interactively and exits `0` without
spending a cent.

## The live calibration run

The first **live** run that produces real numbers is a separate run-the-tool step, not part of building the
harness. Before any live spend the CLI logs the planned call count (`N × cells`); approving that spend is the
operator's gate. Then:

```sh
node benchmark/src/cli.ts --suite benchmark/fixtures --arms A,B,C --n 10 --runner live --md scoreboard.md
```

## Tests

```sh
cd benchmark && node --import tsx --test test/*.test.ts
```

All tests run against the replay Runner — zero API spend.
