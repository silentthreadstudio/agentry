// The pure kind-extractor (ADR-005) — read the routed `Kind` from the conductor's WORK-FOLDER ARTIFACT, the
// SAME faithful mechanism `extractShape` (in `extract.ts`) uses for the complexity shape. This is the SIBLING
// the ADR's Decision.3 chose so the shape extractor's contract stays provably unmodified: `extractShape` reads
// the PRESENCE of `spec.md`/`plan.md`/`tasks/` to infer the shape; `extractKind` reads the `kind` FRONTMATTER
// FIELD inside `spec.md` to read the kind. The two axes are recorded and extracted independently (ADR-005 §4 —
// AC4 orthogonality), so adding this changes nothing about how the shape is measured.
//
// The only I/O is reading `<workingDir>/.agentry/work/*/spec.md` (the artifact the conductor writes on any
// escalation above one-shot). A genuine one-shot writes NO `spec.md`, so its kind is not artifact-visible — the
// extractor returns `null` for it (the one-shot / unlabeled signal, parallel to how `extractShape` falls to the
// settle-signal path when no artifact exists). The AC11 kind fixture is therefore built from ESCALATED tasks.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import type { Kind } from "@agentry/core";

import type { ExtractContext } from "./extract.ts";

/**
 * The `---`-delimited YAML frontmatter block at the head of a markdown file, or `null` when the file has none.
 * Mirrors the conductor's `spec.md` shape: a leading `---` line, the YAML body, a closing `---` line, then prose.
 */
function frontmatterBlock(content: string): string | null {
  // Tolerate a leading BOM () / blank lines, then require the opening fence on its own line.
  const match = /^\uFEFF?\s*---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(content);
  return match === null ? null : match[1]!;
}

/**
 * Read the `kind` field from a `spec.md`'s frontmatter, or `null` when the file has no frontmatter, no `kind`
 * key, or a non-string `kind`. Pure read; a malformed YAML body is tolerated as "no kind" (a degenerate spec is
 * not a crash — one bad artifact must not sink the probe), mirroring how the shape path tolerates a missing tree.
 */
function readKindField(specPath: string): Kind | null {
  let parsed: unknown;
  try {
    const block = frontmatterBlock(readFileSync(specPath, "utf8"));
    if (block === null) return null;
    parsed = parseYaml(block) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const kind = (parsed as Record<string, unknown>).kind;
  // Permissive on the VALUE (mirrors `@agentry/core`'s `Kind = z.string()`): accept any non-empty string kind
  // rather than reject an unknown one, so adding a kind later can't make the extractor silently drop a label.
  return typeof kind === "string" && kind.length > 0 ? kind : null;
}

/**
 * Read the routed {@link Kind} from the conductor's work-folder `spec.md` frontmatter (ADR-005). The only effect
 * is reading every `<workingDir>/.agentry/work/<slug>/spec.md`; the verdict is the first `kind` field found
 * across the work folders, or `null` when none carries one.
 *
 * Returns `null` when:
 *   - there is no `.agentry/work/` (a genuine one-shot writes nothing — its kind is not artifact-visible);
 *   - no work folder holds a `spec.md`;
 *   - no `spec.md`'s frontmatter carries a (non-empty string) `kind` field (an unlabeled / pre-ADR-005 spec).
 *
 * `ctx` is accepted for SIGNATURE PARALLELISM with `extractShape(workingDir, ctx)` but is unused: the kind is a
 * function of the artifact CONTENT alone, so it needs none of the no-artifact settle signals shape uses to tell
 * a one-shot from a degenerate run (a no-artifact run simply has no recorded kind — `null`).
 */
export function extractKind(workingDir: string, _ctx?: ExtractContext): Kind | null {
  const workRoot = join(workingDir, ".agentry", "work");
  if (!existsSync(workRoot) || !statSync(workRoot).isDirectory()) return null;

  for (const slug of readdirSync(workRoot)) {
    const slugDir = join(workRoot, slug);
    if (!statSync(slugDir).isDirectory()) continue;
    const specPath = join(slugDir, "spec.md");
    if (!existsSync(specPath)) continue;
    const kind = readKindField(specPath);
    if (kind !== null) return kind;
  }
  return null;
}
