// src/judge — the shared judge KERNEL (ADR-002). One rubric-parameterized engine + the gating controls every
// public probe judges through: the `JudgeFn`/`realJudgeFn` spawn seam, `judgeWithRubric` (build → spawn → parse →
// normalize `overall = sum / rubric.max`), the `Rubric` value type, and the `aaStability`/`discrimination`
// controls. This file is a PURE re-export barrel (matches @agentry/core) — no logic lives here.

export * from "./engine.ts";
export * from "./rubric.ts";
export * from "./controls.ts";
