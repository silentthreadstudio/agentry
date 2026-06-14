// Shared adapter plumbing — cross-cutting helpers every tool adapter leans on, not fact-specific.
// `guard` wraps a handler so any unexpected throw becomes the `internal` envelope; `partial` maps a
// per-id partial outcome → ok(applied+skipped) / err(not-found) on all-invalid (AC5/Q2).
import type { PartialOutcome } from "../application/memory-service.js";
import { internal, notFound } from "./errors.js";
import { err, ok } from "./result.js";

/**
 * Outermost catch (AC7): any unexpected throw inside a handler becomes the `internal` envelope, so a
 * raw stack/path never reaches the caller and the failure conforms to the AC1 shape — the SDK's own
 * try/catch produces a non-envelope message, so we map the thrown case ourselves.
 */
export type Handler = (args: any) => Promise<ReturnType<typeof ok> | ReturnType<typeof err>>;
export const guard =
  (handler: Handler): Handler =>
  async (args) => {
    try {
      return await handler(args);
    } catch {
      return err(internal());
    }
  };

/**
 * All-ids-invalid (Q2): a per-id partial outcome where nothing applied but ids were requested → a
 * not-found error naming the skipped ids; otherwise the success listing applied + skipped(reason).
 */
export function partial(outcome: PartialOutcome): ReturnType<typeof ok> | ReturnType<typeof err> {
  if (outcome.applied.length === 0 && outcome.requested > 0) {
    const ids = outcome.skipped.map((s) => s.id).join(", ");
    return err(notFound(ids));
  }
  return ok({ applied: outcome.applied, skipped: outcome.skipped });
}
