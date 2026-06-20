// workSlug — a short, stable, collision-resistant label for a run id → the `*.localhost` subdomain.
//
// FLOW run ids slugify the whole goal (e.g. `build-agentry-workbench-the-agentry-agent-center-5s9v6deiit`),
// which makes for ugly, unwieldy URLs. `workSlug` derives a short label that BOTH halves compute
// identically: the web client builds a card's href from it, and the server's host-router resolves a
// requested label back to a run by scanning runs for the one whose `workSlug` (or whose raw id) matches.
//
// A short id (a FLOW "terse" id, ≤ MAX) passes through unchanged. A long one becomes
// `<first-2-words>-<6char-hash-of-the-full-id>` — readable + unique (the hash disambiguates two runs that
// share a leading word). Pure, no I/O; the same function runs in Node (server) and the browser (web).

const MAX = 28;

// FNV-1a over the full id → 6 base36 chars. Deterministic + dependency-free (run ids are scratch labels,
// not security tokens, so a fast non-crypto hash is the right tool).
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(6, "0").slice(-6);
}

/** The short subdomain label for a run id. Idempotent: `workSlug(workSlug(x))` is stable for short ids. */
export function workSlug(runId: string): string {
  if (runId.length <= MAX) return runId;
  const words = runId.split("-").filter(Boolean).slice(0, 2).join("-");
  return `${words}-${hash(runId)}`;
}

/** Resolve a requested subdomain label back to a full run id, given the known run ids. Accepts an exact
 *  id match (short/terse ids, back-compat) OR a `workSlug` match. Returns undefined if nothing matches. */
export function resolveSlug(label: string, runIds: readonly string[]): string | undefined {
  if (runIds.includes(label)) return label;
  return runIds.find((id) => workSlug(id) === label);
}
