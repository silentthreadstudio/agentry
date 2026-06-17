// The recall-LANDING detector — did the warm run actually recall the seeded fact? This is the productized
// SEED-MISS guard: the moat measurement is only valid if the seed reached the conductor. If recall came back
// empty (a seeding/rooting bug), the run tells us nothing about compounding, so the probe must not score it.
//
// SRP: pure predicates over the captured stream TEXT (assistant text + tool_result content). No I/O — the probe
// reads the stream file and hands the text in, so the detection logic is forced-testable with synthetic strings.
//
// Two signals, because a conductor can phrase "empty memory" many ways and can also reason about the task's fork
// WITHOUT memory (a false "surfaced"): an EMPTY tell (recall returned nothing) is decisive on its own — if it
// fires, the seed missed regardless of any downstream wording.

/** Phrasings that mean recall came back EMPTY — the decisive seed-miss tell. */
const EMPTY_RE =
  /recall (returned |came back |is )?empty|0 facts|no precedent|memory.{0,12}(empty|cold)|store is empty|empty store|no (memory|recalled)/i;

/**
 * Did the seeded fact LAND — i.e. did the warm run recall a non-empty store? Returns false the moment an
 * "empty recall" tell appears (the seed never reached the conductor); otherwise true only if a recall actually
 * fired (the caller confirms `memory_recall` was in the tool sequence) — passed in as `recallFired`.
 *
 * @param streamText the run's assistant text + tool_result content (concatenated).
 * @param recallFired whether `memory_recall` appears in the run's tool sequence (the probe extracts this).
 */
export function recallLanded(streamText: string, recallFired: boolean): boolean {
  if (!recallFired) return false; // a run that never recalled can't have landed the seed
  return !EMPTY_RE.test(streamText);
}

/**
 * Did a SPECIFIC seeded fact surface — its distinctive signature appears in the stream (typically inside the
 * `memory_recall` tool_result). Stronger than {@link recallLanded}: it ties the landing to THIS fact, not just a
 * non-empty store. `signature` is a short, fact-specific phrase the fixture provides (e.g. a verbatim clause).
 */
export function factSurfaced(streamText: string, signature: string): boolean {
  if (signature.trim() === "") return false;
  return streamText.toLowerCase().includes(signature.trim().toLowerCase());
}
