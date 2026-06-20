// FlowWriter — the fs-touching write adapter behind the `WriteService` boundary (ADR-006). The ONLY
// writer in the server package: it persists the two write surfaces — an artifact file (a run-root
// `spec.md`/`plan.md`, or a `tasks/NNN-*.md` task file) and the review sidecar (`.review/<gate>.
// annotations.json`). The application (`write-service.ts`) owns the lock + optimistic-concurrency
// gates; this adapter owns only the bytes.
//
// ── Reuse, not fork (ADR-005 tier 1 / ADR-007) ────────────────────────────────────────────────────
// It writes the EXACT on-disk FLOW contract by reusing FLOW's own code, never redeclaring it:
//   - the render        → FLOW's `TaskFileStore.render` shape (`---\n${yaml}---\n\n${body}\n`),
//                         dropping any caller `version` and re-stamping via `computeVersion` — the
//                         byte-for-byte recombination FLOW uses (task-file-store.ts:77).
//   - the version hash  → FLOW's `computeVersion` (domain/version) over (body, frontmatter-sans-
//                         version), so the version this adapter reads back equals the one FLOW stamped
//                         on disk (no second hash algorithm to drift, ADR-006 freshness key).
//   - the file split    → FLOW's `FRONTMATTER` regex (the SAME first-block-only split FsWorkRepository
//                         and TaskFileStore use), so a two-block workbench task file is split exactly
//                         as FLOW splits it: FLOW's lifecycle block is the frontmatter, the planner
//                         meta-block stays at the head of `body` (and is therefore covered by the hash,
//                         exactly as on disk).
//   - run id paths      → FLOW's `runDir` (the traversal-safe layout, ADR-005 §4).
//   - the sidecar       → FLOW's `ReviewComment` shape + the `.review/<gate>.annotations.json` JSON
//                         layout (JsonReviewStore's exact format). The READ-back half reuses the single
//                         parse-tolerant `readSidecar` (`review-sidecar-source.ts`) — one parser, not two.
// `cwd` (the project root) is injected and threaded on every join — no ambient cwd, mirroring FLOW.
//
// It does NOT re-serialize markdown: the body it writes arrives already-normalized (ADR-004; task 14
// runs `normalize` in the route/web path). This adapter only recombines untouched frontmatter + that
// body and re-stamps the version — keeping files-are-truth without a second markdown serializer.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { computeVersion } from "@agentry/flow/domain/version";
import { ReviewComment } from "@agentry/flow/domain/review";
import { runDir } from "@agentry/flow/resolution/run-pointer";
import { assertSafeSegment } from "@agentry/flow/domain/ids";
import { readSidecar } from "./review-sidecar-source.js";

// FLOW's frontmatter splitter (task-file-store.ts) — the SAME pattern, reused not forked. Group 1 =
// the YAML between the first `---` fence; group 2 = the remaining body (which, for a workbench task
// file, still carries the planner meta-block — exactly as FLOW leaves it).
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

// An artifact addressed for read/write: a run-root artifact by `kind`, or a task file by `taskNo`.
// Exactly one is set (the application validates the request shape; this adapter trusts the resolved
// target). Mirrors FLOW's split between `readArtifact(kind)` and `readTask(taskNo)`.
export type ArtifactTarget =
  | { kind: "spec" | "plan" }
  | { taskNo: string };

// The current on-disk state of an artifact — frontmatter (with `version` stripped, the way the hash
// sees it), the body, and the recomputed current `version`. `undefined` when the file is absent.
export interface CurrentArtifact {
  frontmatter: Record<string, unknown>; // frontmatter WITHOUT the `version` field
  body: string; // the body as it sits on disk (includes a task's meta-block)
  version: string; // computeVersion(body, frontmatter) — equals FLOW's stamped version
}

// The write port the application (`WriteService`) depends on — interfaces only, so the service is
// unit-testable against a fake with no fs (ADR-001). The fs adapter (`FlowWriter`) implements it.
export interface FlowWriterPort {
  // Re-read the artifact from disk (truth at write time), or undefined when absent.
  readArtifact(run: string, target: ArtifactTarget): CurrentArtifact | undefined;
  // Recombine untouched `frontmatter` + the (already-normalized) `body` and re-stamp the version;
  // returns the freshly-stamped version. Frontmatter is written as-is minus any stale `version`.
  writeArtifact(
    run: string,
    target: ArtifactTarget,
    frontmatter: Record<string, unknown>,
    body: string,
  ): string;
  // Append a validated `ReviewComment` to the gate's sidecar (the JsonReviewStore layout).
  appendComment(run: string, gate: string, comment: ReviewComment): void;
  // Mark a comment `resolved:true` in the gate's sidecar by id. Returns true when a matching comment
  // was found+rewritten, false when the id is absent (the route maps that to 404). Idempotent.
  resolveComment(run: string, gate: string, commentId: string): boolean;
}

export class FlowWriter implements FlowWriterPort {
  constructor(private readonly cwd: string) {}

  readArtifact(run: string, target: ArtifactTarget): CurrentArtifact | undefined {
    const path = this.artifactPath(run, target);
    if (path === undefined || !existsSync(path)) return undefined;
    return this.parse(readFileSync(path, "utf8"));
  }

  writeArtifact(
    run: string,
    target: ArtifactTarget,
    frontmatter: Record<string, unknown>,
    body: string,
  ): string {
    const path = this.resolveWritePath(run, target);
    mkdirSync(join(path, ".."), { recursive: true });
    const { rendered, version } = this.render(frontmatter, body);
    writeFileSync(path, rendered);
    return version;
  }

  appendComment(run: string, gate: string, comment: ReviewComment): void {
    assertSafeSegment(gate); // the gate becomes a filename — never let it escape .review/
    const validated = ReviewComment.parse(comment);
    const dir = join(runDir(this.cwd, run), ".review");
    const file = join(dir, `${gate}.annotations.json`);
    const existing = readSidecar(file);
    mkdirSync(dir, { recursive: true });
    // The SAME on-disk layout JsonReviewStore writes (2-space JSON + trailing newline), so the two
    // writers of this sidecar stay byte-compatible.
    writeFileSync(file, `${JSON.stringify([...existing, validated], null, 2)}\n`);
  }

  // Flip `resolved:true` on the comment with `commentId` in the gate sidecar, rewriting the file in the
  // SAME JsonReviewStore layout. Read-modify-write by id: absent id ⇒ false (no write), found ⇒ true.
  resolveComment(run: string, gate: string, commentId: string): boolean {
    assertSafeSegment(gate);
    const file = join(runDir(this.cwd, run), ".review", `${gate}.annotations.json`);
    const existing = readSidecar(file);
    let found = false;
    const next = existing.map((c) => {
      if (c.id !== commentId) return c;
      found = true;
      return { ...c, resolved: true };
    });
    if (!found) return false;
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────

  // Split the file FLOW's way and recompute the version over (body, frontmatter-sans-version) — so
  // the version returned here is the one FLOW stamped on disk. The body is `.trim()`ed exactly as
  // FLOW's `readArtifact`/`parseTaskFile` trim it: FLOW's `render` writes `\n\n${body}\n` but stamps
  // the version over the TRIMMED body, so reading back the raw inter-fence text and hashing it
  // un-trimmed would not match the stamped version (the `\n\n…\n` padding would perturb the hash).
  // A file with no fence is all body (empty frontmatter), never a throw (mirrors FsWorkRepository).
  private parse(text: string): CurrentArtifact {
    const m = FRONTMATTER.exec(text);
    const front = m ? ((parseYaml(m[1] ?? "") ?? {}) as Record<string, unknown>) : {};
    const body = (m ? (m[2] ?? "") : text).trim();
    const { version: _dropped, ...sansVersion } = front;
    return {
      frontmatter: sansVersion,
      body,
      version: computeVersion(body, sansVersion),
    };
  }

  // FLOW's exact render (task-file-store.ts:77): drop any caller `version`, re-stamp over (body,
  // frontmatter-sans-version), emit `---\n${yaml}---\n\n${body}\n`. Returns the rendered bytes and
  // the stamped version so the caller (and the WriteService) can echo the new version to the client.
  private render(
    frontmatter: Record<string, unknown>,
    body: string,
  ): { rendered: string; version: string } {
    const { version: _dropped, ...front } = frontmatter;
    const version = computeVersion(body, front);
    const stamped = { ...front, version };
    return { rendered: `---\n${stringifyYaml(stamped)}---\n\n${body}\n`, version };
  }

  // The on-disk path of an artifact target for READ — a run-root `<kind>.md`, or the existing
  // `tasks/NNN-*.md` file (found by its number prefix, the way FLOW's `readTask` finds it). Returns
  // undefined for a task whose file does not yet exist (an absent artifact reads as undefined).
  private artifactPath(run: string, target: ArtifactTarget): string | undefined {
    const dir = runDir(this.cwd, run);
    if ("kind" in target) return join(dir, `${target.kind}.md`);
    assertSafeSegment(target.taskNo);
    const tasksDir = join(dir, "tasks");
    if (!existsSync(tasksDir)) return undefined;
    const prefix = `${target.taskNo}-`;
    const file = readdirSync(tasksDir).find((f) => f.startsWith(prefix) && f.endsWith(".md"));
    return file ? join(tasksDir, file) : undefined;
  }

  // The path to WRITE a target. For a task we never write to a fresh name (the WriteService only
  // writes after a successful read at the same target, so the file exists) — but if FLOW renamed the
  // slug we still target the existing file by its number prefix; absent ⇒ a hard error (writing a
  // task that was never read is a misuse the application gates against).
  private resolveWritePath(run: string, target: ArtifactTarget): string {
    const path = this.artifactPath(run, target);
    if (path !== undefined) return path;
    // Only reachable for a `kind` artifact whose file is absent (a first write); artifactPath always
    // returns a `kind` path. A task with no existing file is a programming error here.
    if ("taskNo" in target) {
      throw new Error(`flow-writer: no task file for ${target.taskNo} in run ${run} to write`);
    }
    return join(runDir(this.cwd, run), `${target.kind}.md`);
  }
}
