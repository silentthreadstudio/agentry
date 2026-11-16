import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { filterPath } from "./run-plugin-tests.mjs";

const PLUGIN_BIN = resolve(dirname(fileURLToPath(import.meta.url)), "..", "plugin", "bin", "agentry");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "run-plugin-tests-")));
after(() => rmSync(tmp, { recursive: true, force: true }));

const dirWith = (name, place) => {
  const dir = join(tmp, name);
  mkdirSync(dir);
  place(join(dir, "agentry"));
  return dir;
};

test("drops a dir whose agentry links to this plugin's bin", () => {
  const dir = dirWith("plugin", (p) => symlinkSync(PLUGIN_BIN, p));
  const keep = dirWith("plain", (p) => writeFileSync(p, "x"));
  assert.equal(filterPath([dir, keep].join(delimiter)), keep);
});

test("keeps a dir whose agentry is another executable", () => {
  const dir = dirWith("other", (p) => {
    writeFileSync(p, "#!/bin/sh\n");
    chmodSync(p, 0o755);
  });
  const link = dirWith("otherlink", (p) => symlinkSync(join(dir, "agentry"), p));
  assert.equal(filterPath([dir, link].join(delimiter)), [dir, link].join(delimiter));
});
