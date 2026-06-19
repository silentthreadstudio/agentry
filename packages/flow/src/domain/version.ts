// Version hash — the tool-stamped content fingerprint (spec AC4/AC5). PURE (crypto only, no I/O —
// mirrors the memory domain's `id.ts`, which treats `node:crypto` as pure computation). The TOOL
// computes this on every artifact/task write; the CALLER never supplies a `version` (the whole point
// of AC4: editing the body and rewriting yields a *different* version, because it is derived, not
// passed). `frontmatterSansVersion` is the file's frontmatter with the `version` field itself
// removed — so the hash covers everything that defines the file except its own fingerprint.
import { createHash } from "node:crypto";

// Deterministic over (body, frontmatter): same input → same hash (idempotent re-write keeps version);
// any change to body OR a frontmatter field → different hash. Frontmatter keys are sorted so key
// ordering in the record can't perturb the hash (two records with the same fields hash identically).
export function computeVersion(body: string, frontmatterSansVersion: Record<string, unknown>): string {
  const sortedKeys = Object.keys(frontmatterSansVersion).sort();
  const canonicalFront = JSON.stringify(frontmatterSansVersion, sortedKeys);
  const hash = createHash("sha256");
  hash.update(canonicalFront, "utf8");
  hash.update("\n", "utf8"); // separator so {front:"a",body:"b"} ≠ {front:"ab",body:""}
  hash.update(body, "utf8");
  return hash.digest("hex").slice(0, 16);
}
