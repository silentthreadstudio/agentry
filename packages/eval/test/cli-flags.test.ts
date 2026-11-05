// `--k`, `--runs`, `--concurrency` and `--timeout` are validated like `--budget-usd`: a non-number, a fraction or
// anything below 1 is a usage error (exit 2) BEFORE a run dir is opened. A bare `Number()` used to turn `abc` into
// `NaN`, which quietly ran zero work items and still exited 0. ZERO API: the runner must never be reached.

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.ts";
import type { Runner } from "../src/io/port.ts";

const BENCH_MINI_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bench-mini");

const neverRuns: Runner = {
  run() {
    throw new Error("a rejected flag must fail before any run starts");
  },
};

async function quietMain(argv: string[]): Promise<number> {
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr.write as unknown as (s: string) => boolean) = () => true;
  try {
    return await main(argv, { runner: neverRuns });
  } finally {
    process.stderr.write = orig;
  }
}

for (const flag of ["--k", "--runs", "--concurrency", "--timeout"]) {
  test(`${flag}: a non-number, a fraction, zero or a negative is exit 2 and opens no run`, async () => {
    for (const bad of ["abc", "2.5", "0", "-1", ""]) {
      const runsRoot = mkdtempSync(join(tmpdir(), "selfeval-flags-"));
      const code = await quietMain([
        "run",
        "bench",
        "--fixtures-dir",
        BENCH_MINI_DIR,
        "--runs-root",
        runsRoot,
        flag,
        bad,
      ]);

      assert.equal(code, 2, `${flag} ${JSON.stringify(bad)} must exit 2`);
      assert.deepEqual(readdirSync(runsRoot), [], "no run dir may be left behind");
    }
  });
}
