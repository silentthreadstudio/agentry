// Graduation flows (pure) — distill: episodes → draft facts; consolidate: facts → skill proposals.
// Both are PROPOSE-only: they return drafts/proposals; writing/installing is the caller's (gated) job.
import type { Episode, Fact, MemoryType } from "@agentry/core";

export interface DraftFact {
  type: MemoryType;
  text: string;
  provenance: string[];
}
export interface DistillCluster {
  episodes: string[];
  draftFacts: DraftFact[];
}

/**
 * v1 distill: each undistilled episode carrying a lesson → a draft fact citing it (provenance).
 * Similarity-clustering across episodes is a benchmark-driven enhancement (doc 03).
 */
export function distill(undistilled: Episode[]): DistillCluster[] {
  return undistilled
    .filter((e) => (e.lesson ?? "").trim().length > 0)
    .map((e) => ({
      episodes: [e.id],
      draftFacts: [{ type: "gotcha", text: (e.lesson ?? "").trim(), provenance: [e.id] }],
    }));
}

export const MIN_RECURRENCE = 3; // K — knob (doc 07 §6)
export const MIN_USEFULNESS = 2; // floor — knob

export interface SkillProposal {
  pattern: string;
  supportingMemoryIds: string[];
  draftSkill: { name: string; description: string; body: string };
}

/** v1 consolidate: cluster active facts by tag; a tag recurring across ≥K facts above the usefulness floor becomes a skill PROPOSAL. */
export function consolidate(
  facts: Fact[],
  minRecurrence = MIN_RECURRENCE,
  minUsefulness = MIN_USEFULNESS,
): SkillProposal[] {
  const byTag = new Map<string, Fact[]>();
  for (const f of facts)
    for (const tag of f.tags ?? []) {
      const group = byTag.get(tag) ?? [];
      group.push(f);
      byTag.set(tag, group);
    }

  const proposals: SkillProposal[] = [];
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
