// FsReviewSidecarSource — the fs adapter behind the `ReviewSidecarSource` port (ADR-001), and the SINGLE
// parse-tolerant reader of the `.review/<gate>.annotations.json` sidecars. Consolidates the read that used
// to live in three places (GateInbox, the route's review reader, and FlowWriter) into one: `readSidecar`
// here is the only `ReviewComment[]` parser, reused by `FlowWriter` for its read-modify-write too.
//
// ── Reuse, not fork (ADR-005 tier 1) ───────────────────────────────────────────────────────────────────
// The sidecar shape is FLOW's `ReviewComment[]` (JsonReviewStore's layout). A non-array or a file that
// fails to parse reads as `[]` (the SAME tolerance FLOW's `JsonReviewStore.read` gives — a half-written
// sidecar never throws). A single ill-formed comment drops the whole file to empty, matching FLOW.
//
// `cwd` (the project root) is injected and threaded via FLOW's traversal-safe `runDir` — no ambient cwd.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ReviewComment } from "@agentry/flow/domain/review";
import { runDir } from "@agentry/flow/resolution/run-pointer";
import type { ReviewSidecarSource } from "../domain/ports.js";

const SIDECAR_SUFFIX = ".annotations.json";

export class FsReviewSidecarSource implements ReviewSidecarSource {
  constructor(private readonly cwd: string) {}

  // The gate stems present under one run's `.review/` (sorted, stable), or `[]` when the dir is absent.
  // The stem is the filename minus the `.annotations.json` suffix — the gate key the inbox folds over.
  listGates(run: string): string[] {
    const dir = join(runDir(this.cwd, run), ".review");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((file) => file.endsWith(SIDECAR_SUFFIX))
      .map((file) => file.slice(0, -SIDECAR_SUFFIX.length))
      .sort();
  }

  // One gate's validated `ReviewComment[]`, or `[]` when the sidecar is absent/corrupt. The single
  // parse-tolerant reader (see header) — every sidecar read in the package routes through here.
  commentsFor(run: string, gate: string): ReviewComment[] {
    const file = join(runDir(this.cwd, run), ".review", `${gate}${SIDECAR_SUFFIX}`);
    return readSidecar(file);
  }
}

// Parse one sidecar file into validated `ReviewComment[]`. The canonical reader: a non-array or a file
// that fails to parse reads as `[]` (FLOW's tolerance); a single ill-formed comment drops the file to
// empty. Exported for `FlowWriter`'s read-modify-write so the two writers share one parser.
export function readSidecar(file: string): ReviewComment[] {
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.map((c) => ReviewComment.parse(c));
  } catch {
    return [];
  }
}
