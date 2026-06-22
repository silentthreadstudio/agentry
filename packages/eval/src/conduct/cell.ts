// SHARED CONDUCT INFRA (relocated by T-10 from `outcome/cell.ts`). `Cell` + `agentryCell`/`AGENTRY_CELL` are
// consumed by the live rightsizing probe + the CLI, so they survived the deletion of `outcome/` and now live in the
// NEUTRAL `src/conduct/` home — no probe imports another probe's old folder.
//
// The Cell record + the Agentry matrix cell (ADR-002 / ADR-003). A `Cell` is the DATA that distinguishes one arm
// of the matrix from another — the cell asymmetry is data, not a code fork (ADR-002). The public bench is
// Agentry-value-only (ADR-003): the bare baseline is RETIRED, so the matrix has a single Agentry arm that loads the
// plugin (`pluginDir`) and routes the prompt through `/agentry:go`. The runner (`runner.ts`) turns a Cell + a
// fixture into the per-cell `Invocation`.
//
// The cell `id` is the model-derived label (ADR-003): `Agentry-<model>`, where `<model>` comes from the `--model`
// flag — NOT a hardcoded model name. An Opus-later run labels as Opus, and runs across models don't collide on the
// same id. `agentryCell(model)` builds the cell for a given model; `CELLS` is the default matrix at the default model.

/** The default model id when `--model` is not supplied (mirrors `runner.ts`'s `DEFAULT_MODEL`). */
export const DEFAULT_CELL_MODEL = "sonnet";

/**
 * One cell of the outcome matrix — the per-arm differences the runner bakes into the `Invocation`:
 *   - `id` the cell label stamped onto records (`Agentry-<model>`, derived from the `--model` flag — ADR-003);
 *   - `loadsPlugin` is whether this cell loads the Agentry plugin (`--plugin-dir`) — its presence ALSO gates
 *     `bypassPermissions` (an Agentry cell must dispatch subagents headless). The actual repo path is resolved by
 *     the runner caller, not hard-coded here; the Cell only declares WHETHER a plugin is loaded (a marker), and the
 *     runner substitutes the resolved path.
 *   - `promptWrap` transforms the fixture's raw prompt into the prompt the cell hands `claude -p` (Agentry = the
 *     prompt routed through the `/agentry:go` front door — identity here, the runner owns the real construction).
 */
export interface Cell {
  /** The cell label (also the matrix column / record key): `Agentry-<model>`. */
  id: string;
  /** Marker: this cell loads the Agentry plugin. The runner resolves the actual `--plugin-dir` path. */
  loadsPlugin: boolean;
  /** Wrap the fixture's raw prompt into the prompt this cell invokes (Agentry = identity; the runner builds the real prompt). */
  promptWrap: (prompt: string) => string;
}

/**
 * The Agentry cell for a given model: `claude -p --model <model> --plugin-dir <agentry>` with `bypassPermissions`
 * so the conductor can dispatch subagents headless. CRITICAL: the prompt is NOT the `/agentry:go <task>` slash form
 * — in headless `-p` that is a 0-turn no-op (the slash command expands and exits without a model turn). The runner
 * instead delivers the EXPANDED go.md conductor prompt as plain text (see `buildConductorPrompt` in runner.ts), so
 * the conducting skill actually runs. `promptWrap` is therefore identity here — the runner owns the real construction.
 *
 * The `id` derives from the model (ADR-003), so the stored label matches the model that actually ran.
 */
export function agentryCell(model: string = DEFAULT_CELL_MODEL): Cell {
  return {
    id: `Agentry-${model}`,
    loadsPlugin: true,
    promptWrap: (prompt) => prompt,
  };
}

/** The default Agentry cell at the default model — the fallback matrix when the caller pins no model. */
export const AGENTRY_CELL: Cell = agentryCell();

/** The matrix: the single Agentry arm (the bare baseline is retired — ADR-003). The caller pins the model via `agentryCell`. */
export const CELLS: readonly Cell[] = [AGENTRY_CELL];
