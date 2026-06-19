// Review store — the per-gate sidecar `.agentry/work/<run>/.review/<gate>.annotations.json` (AC10).
// One of the state holders (AC6: comments survive a server kill). Comments are validated through the
// `ReviewComment` schema on both read and write, so a corrupt sidecar can't surface an ill-formed
// comment to the caller. The gate name is guarded as a safe segment (it becomes a filename).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertSafeSegment } from "../domain/ids.js";
import type { ReviewStore as ReviewStorePort } from "../domain/ports.js";
import { ReviewComment } from "../domain/review.js";
import { runDir } from "../resolution/run-pointer.js";

export class JsonReviewStore implements ReviewStorePort {
  constructor(private readonly cwd: string) {}

  private gateFile(run: string, gate: string): string {
    assertSafeSegment(gate); // the gate becomes a filename — never let it escape .review/
    return join(runDir(this.cwd, run), ".review", `${gate}.annotations.json`);
  }

  read(run: string, gate: string): ReviewComment[] {
    const file = this.gateFile(run, gate);
    if (!existsSync(file)) return [];
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(raw)) return [];
      return raw.map((c) => ReviewComment.parse(c));
    } catch {
      return []; // a corrupt/partially-written sidecar reads as empty rather than throwing
    }
  }

  write(run: string, gate: string, comments: ReviewComment[]): void {
    const validated = comments.map((c) => ReviewComment.parse(c));
    const file = this.gateFile(run, gate);
    mkdirSync(join(runDir(this.cwd, run), ".review"), { recursive: true });
    writeFileSync(file, `${JSON.stringify(validated, null, 2)}\n`);
  }
}
