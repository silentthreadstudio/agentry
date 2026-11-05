// Graduation flows (pure) — distill: episodes -> draft facts; consolidate: facts -> skill proposals.
// Both are PROPOSE-only: they return drafts/proposals; writing/installing is the caller's (gated) job.

/**
 * Each undistilled episode carrying a lesson -> a draft fact citing it (provenance).
 * distill(undistilled) -> [{ episodes: [id], draftFacts: [{ type, text, provenance }] }]
 */
export function distill(undistilled) {
  return undistilled
    .filter((e) => (e.lesson ?? "").trim().length > 0)
    .map((e) => ({
      episodes: [e.id],
      draftFacts: [{ type: "gotcha", text: (e.lesson ?? "").trim(), provenance: [e.id] }],
    }));
}

export const MIN_RECURRENCE = 3; // K
export const MIN_USEFULNESS = 2; // floor

/**
 * Cluster active facts by tag; a tag recurring across >= K facts above the usefulness floor becomes a
 * skill PROPOSAL.
 * consolidate(facts, minRecurrence?, minUsefulness?) ->
 *   [{ pattern, supportingMemoryIds, draftSkill: { name, description, body } }]
 */
export function consolidate(facts, minRecurrence = MIN_RECURRENCE, minUsefulness = MIN_USEFULNESS) {
  const byTag = new Map();
  for (const f of facts)
    for (const tag of f.tags ?? []) {
      const group = byTag.get(tag) ?? [];
      group.push(f);
      byTag.set(tag, group);
    }

  const proposals = [];
  for (const [tag, group] of byTag) {
    const avgUsefulness = group.reduce((s, f) => s + f.usefulness, 0) / group.length;
    if (group.length >= minRecurrence && avgUsefulness >= minUsefulness) {
      proposals.push({
        pattern: tag,
        supportingMemoryIds: group.map((f) => f.id),
        draftSkill: {
          name: tag,
          description: `Recurring pattern around "${tag}" (${group.length} facts).`,
          body: group.map((f) => `- ${f.text}`).join("\n"),
        },
      });
    }
  }
  return proposals;
}
