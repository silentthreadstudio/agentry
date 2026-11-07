// vendor — vendor/ is built, never committed, so a clean checkout has none: the first test file to load
// builds it (into a scratch dir, then renamed into place so a parallel test file never reads half a copy).
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../../../scripts/build-agentry-opencode.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!existsSync(join(PKG, "vendor", "scripts"))) {
  const scratch = mkdtempSync(join(tmpdir(), "agentry-vendor-"));
  try {
    await generate(scratch);
    renameSync(join(scratch, "vendor"), join(PKG, "vendor"));
  } catch {
    // another test file won the rename: its copy is the same bytes
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
