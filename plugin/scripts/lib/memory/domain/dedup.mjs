// Dedup — pure. Cheap similarity to decide reinforce-vs-create on write.

/** Reinforce instead of creating a new fact when similarity >= this. */
export const DEDUP_THRESHOLD = 0.82;

const tokenize = (s) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );

/** Jaccard similarity of word sets — a cheap, deterministic dedup signal. */
export function similarity(a, b) {
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}
