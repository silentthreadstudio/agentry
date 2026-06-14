// Deterministic content hash of a source tree — the dist-lockstep signal.
//
// mtimes are not preserved by git (a clone / checkout / squash-merge rewrites them), so comparing
// dist-vs-src mtimes yields false "dist is stale" warnings. Hashing file *contents* is checkout-proof:
// build.mjs stamps this hash into the committed dist, and check-plugin recomputes + compares it.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// SHA-256 over every file's POSIX-normalized relative path + its bytes, in sorted path order.
// Path order makes it stable across filesystems; including the path catches renames/moves.
export function srcHash(srcDir) {
  const files = readdirSync(srcDir, { recursive: true })
    .map((f) => join(srcDir, String(f)))
    .filter((p) => statSync(p).isFile())
    .map((p) => relative(srcDir, p).split(sep).join("/"))
    .sort();
  const h = createHash("sha256");
  for (const rel of files) {
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(join(srcDir, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}
