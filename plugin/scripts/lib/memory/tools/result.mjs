// result — what a verb hands back to the command runner: `ok(data)` (printed, exit 0) or `refused(envelope)`
// (the reason printed, exit 1). `failed` maps a service outcome that did not succeed; `partial` maps a per-id partial outcome (feedback, distill stamp): the
// applied and skipped ids, or — when ids were asked for and none applied — a not-found naming them.
import { badInput, notFound, notFoundMany } from "./errors.mjs";

export const ok = (data) => ({ data });
export const refused = (error) => ({ error });

export function partial(outcome) {
  if (outcome.applied.length === 0 && outcome.requested > 0) {
    const ids = outcome.skipped.map((s) => s.id);
    return refused(ids.length === 1 ? notFound(ids[0]) : notFoundMany(ids));
  }
  return ok({ applied: outcome.applied, skipped: outcome.skipped });
}

/** A failed service outcome as its refusal; `invalidState(outcome)` words the one case only the verb knows
 *  (forget has none). */
export function failed(outcome, invalidState) {
  if (outcome.reason === "bad-input") return refused(badInput(outcome.field, outcome.rule));
  if (outcome.reason === "not-found") return refused(notFound(outcome.id));
  return refused(invalidState(outcome));
}
