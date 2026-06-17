// Run-id generation (ADR-001). A run id is a sortable wall-clock prefix + a short random suffix:
// `YYYYMMDD-HHMMSS-<rand4>`. The timestamp prefix gives free chronological `ls runs/` ordering for
// `replay <latest>`; the 4-hex suffix disambiguates two runs started in the same second with no collision risk.
//
// SRP: this module is the id function only. `new Date()` is permitted at selfeval runtime (only workflow SCRIPTS
// forbid wall-clock; this is a CLI run — ADR-001). The `--run-id` override is what makes a replay/test path
// deterministic: pass a fixed id and the generator returns it unchanged.

import { randomBytes } from "node:crypto";

/** Zero-pad a number to a fixed width (e.g. month 6 → "06"). */
function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Generate a run id, or return `override` verbatim when one is given.
 *
 * Generated form: `YYYYMMDD-HHMMSS-<rand4>` where `<rand4>` is 4 lowercase hex chars from `crypto.randomBytes`.
 * @param override When provided (e.g. a `--run-id` flag or a test), returned unchanged for a deterministic id.
 */
export function newRunId(override?: string): string {
  if (override !== undefined) return override;

  const now = new Date();
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}`;
  const time = `${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}`;
  const rand = randomBytes(2).toString("hex"); // 2 bytes → 4 lowercase hex chars
  return `${date}-${time}-${rand}`;
}
