// Shared adapter plumbing — cross-cutting helpers every tool adapter (T02–T05) leans on. `guard`
// wraps a handler so any unexpected throw becomes the `internal` envelope, mirroring
// @agentry/memory's tools/adapter.ts (do not invent a new shape — Notes).
import { internal } from "./errors.js";
import { err, ok } from "./result.js";

/**
 * Outermost catch: any unexpected throw inside a handler becomes the `internal` envelope, so a raw
 * stack/path never reaches the caller and the failure conforms to the envelope shape — the SDK's own
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
