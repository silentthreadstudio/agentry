// recall — which memory facts a lane brief carries: this repo's store, the user's own and the
// cross-project facts, never another project's, ranked for the contract and capped by `primeLimit`, and
// only when the repo's `memory.prime` is "all" (briefs are primed). Reads the memory store; writes
// nothing.
import { rankFacts, readFacts, readMemoryConfig } from "../memory/recall.mjs";

// A brief may carry what this repo's store holds, plus the user's own (`scope: user`) and the
// cross-project (`scope: global`) facts from the home store. The home store also keeps facts written
// for other projects (a `repo` fact with no project store goes there) and unscoped ones: those never
// belong in this repo's brief.
export const forThisRepo = (fact) =>
  fact.source === "project" || fact.scope === "user" || fact.scope === "global";

/** How many ranked facts a prime may carry: the config's `primeLimit` when a whole number above 0, else 5. */
export const primeLimitOf = (config) =>
  Number.isInteger(config.primeLimit) && config.primeLimit > 0 ? config.primeLimit : 5;

/** The facts recalled for this contract: `{ prime, facts }`. Facts only when the repo's
 *  `memory.prime` is "all" (briefs are primed); otherwise none. */
export function recalledFacts(root, { owned, block }) {
  const config = readMemoryConfig(root);
  if (config.prime !== "all") return { prime: config.prime, facts: [] };
  const head = String(block ?? "")
    .split("\n")
    .slice(0, 2)
    .join(" ");
  const task = [...owned, head].join(" ");
  return {
    prime: config.prime,
    facts: rankFacts(readFacts(root).filter(forThisRepo), task, primeLimitOf(config)),
  };
}
