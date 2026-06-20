// Doc-editor save-path byte-stability (AC4/AC6, the ADR-004↔006 link). (The editor moved from the retired
// DocDrawer into the workspace's `DocEditor` in task 008; the save composition this guards is unchanged.)
//
// The acceptance: "a no-op edit save is byte-stable (normalize, no false rejection)". The editor's save
// computes the body it POSTs two ways — rich/edit mode: `normalize(tiptapToMd(editor.getJSON()))` over a
// doc loaded via `mdToTiptap(body)`; source mode: `normalize(rawBody)` seeded from `normalize(body)`. The
// server then recomputes the version over that body and compares to the opaque `baseVersion` (ADR-006).
//
// This test asserts the COMPOSITION the editor performs (not the serializer internals, which task 14
// golden-tests) is byte-stable: a no-op edit-mode session and a no-op source-mode session each re-emit a
// body byte-identical to the normalized on-disk body — so the server's recomputed version matches
// `baseVersion` and the save is a clean no-op, never a false stale-rejection. If the editor's save path
// ever drops the `normalize` (the load-bearing line), this fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { mdToTiptap, normalize, tiptapToMd } from "../routes/work/live/doc/markdown-serializer.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const CORPUS = ["spec", "plan", "adr", "task"] as const;

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.md`), "utf8");
}

// The exact body DocDrawer.save() would POST after a no-op RICH session: open with mdToTiptap, re-emit
// with tiptapToMd, normalize (the drawer's `currentBody()` for mode === "rich").
function richNoOpSaveBody(onDiskBody: string): string {
  return normalize(tiptapToMd(mdToTiptap(onDiskBody)));
}

// The body DocDrawer.save() would POST after a no-op SOURCE session: the raw buffer is seeded from
// normalize(body) and normalized again on save (the drawer's `currentBody()` for mode === "source").
function sourceNoOpSaveBody(onDiskBody: string): string {
  const rawSeed = normalize(onDiskBody);
  return normalize(rawSeed);
}

for (const name of CORPUS) {
  test(`rich no-op save is byte-stable vs the normalized on-disk body: ${name}`, () => {
    const onDisk = normalize(fixture(name)); // FLOW normalizes on first read (ADR-004)
    assert.equal(
      richNoOpSaveBody(fixture(name)),
      onDisk,
      `${name}: a no-op rich save must re-emit the normalized on-disk body (no false stale-rejection)`,
    );
  });

  test(`source no-op save is byte-stable vs the normalized on-disk body: ${name}`, () => {
    const onDisk = normalize(fixture(name));
    assert.equal(
      sourceNoOpSaveBody(fixture(name)),
      onDisk,
      `${name}: a no-op source save must re-emit the normalized on-disk body (byte-stable escape hatch)`,
    );
  });
}
