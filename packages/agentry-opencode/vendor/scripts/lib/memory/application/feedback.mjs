// Feedback — how a run's usefulness signal moves facts. The rules, apart from the store: used+pass boosts
// and clears the strikes, used+fail lowers confidence, recalled-but-unused decays and strikes (and
// self-archives past the threshold), a recall miss nudges confidence up. Only an active fact is ever
// changed: recall only returns active facts, so a superseded or archived id here is skipped, never mutated
// (supersession is terminal; an archived fact comes back through recover).
//
// applyFeedback(facts, input, ts, save) -> { applied, skipped: [{ id, reason }], requested }
//   facts: Map id -> fact (read as `save` updates it); save(fact) stores a changed fact.
//   input: { recalled, used, outcome: "pass" | "fail", recallMisses? }
// A strike counter at ARCHIVE_THRESHOLD, with usefulness floored at 0, archives the fact.

export const ARCHIVE_THRESHOLD = 4;

export function applyFeedback(facts, input, ts, save) {
  const used = new Set(input.used);
  const applied = [];
  const skipped = [];
  const recalledUsed = new Set([...input.recalled, ...input.used]);
  for (const id of recalledUsed) {
    const fact = facts.get(id);
    if (!fact) {
      skipped.push({ id, reason: "no such fact exists" });
      continue;
    }
    if (fact.status !== "active") {
      skipped.push({ id, reason: `fact is '${fact.status}', not active` });
      continue;
    }
    if (used.has(id)) {
      save(
        input.outcome === "pass"
          ? // cited + helped: boost and clear strikes — a used fact is alive
            {
              ...fact,
              usefulness: fact.usefulness + 1,
              confidence: Math.min(1, fact.confidence + 0.05),
              decay: 0,
              updatedAt: ts,
            }
          : // suspect: lower confidence, but it was relevant/used — don't strike toward archive
            { ...fact, confidence: Math.max(0, fact.confidence - 0.1), decay: 0, updatedAt: ts },
      );
    } else {
      // recalled, not used: decay usefulness and add a strike; self-archive once strikes cross the
      // threshold AND usefulness has floored at 0 (a fresh fact at 0 isn't archived until it earns strikes).
      const usefulness = Math.max(0, fact.usefulness - 0.25);
      const decay = fact.decay + 1;
      const archive = decay >= ARCHIVE_THRESHOLD && usefulness === 0;
      save({
        ...fact,
        usefulness,
        decay,
        updatedAt: ts,
        ...(archive ? { status: "archived", archivedAt: ts } : {}),
      });
    }
    applied.push(id);
  }
  for (const id of input.recallMisses ?? []) {
    if (recalledUsed.has(id)) continue; // already counted above — don't double-report
    const fact = facts.get(id);
    if (fact) {
      save({ ...fact, confidence: Math.min(1, fact.confidence + 0.05), updatedAt: ts });
      applied.push(id);
    } else {
      skipped.push({ id, reason: "no such fact exists" });
    }
  }
  const requested =
    recalledUsed.size + (input.recallMisses ?? []).filter((id) => !recalledUsed.has(id)).length;
  return { applied, skipped, requested };
}
