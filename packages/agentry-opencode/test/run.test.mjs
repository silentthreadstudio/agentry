// Tests for src/run.mjs, the seam between the package's tools and the vendored router: exit 0 and 1
// map to the CLI's own text as content, exit 2 to an Error carrying the CLI's printed line verbatim,
// nothing ever touches the process's exit state, and the tools share this seam (no private router
// calls in the tool files). Runs against a temp synthetic board, offline.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runVerb } from "../src/run.mjs";
import { fixtureCleanup, mkBoard } from "./fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAY = await import(new URL("../vendor/scripts/lib/cli/help.mjs", import.meta.url));
const RUN = readFileSync(join(HERE, "..", "src", "run.mjs"), "utf8");
const BOARD = readFileSync(join(HERE, "..", "src", "tools", "board.mjs"), "utf8");

after(fixtureCleanup);

test("exit 0 is the CLI's own text as content", async () => {
  const root = mkBoard();
  const got = await runVerb("board", ["status"], { root });
  assert.deepEqual(got, { content: [{ type: "text", text: got.content[0].text }] });
  assert.match(got.content[0].text, /^✓ Sample {2}OK[^\n]*\n\nNow {8}A2 /);
});

test("exit 1 is findings as content, never an error", async () => {
  const { dir } = { dir: mkBoard("evidence-board") };
  const got = await runVerb("board", ["check"], { root: dir });
  assert.match(got.content[0].text, /✗ Release {2}5 problems · .* · exit 1/);
});

test("exit 2 throws an Error carrying the CLI's own line verbatim", async () => {
  const root = mkBoard();
  await assert.rejects(
    () => runVerb("board", ["contract"], { root }),
    (error) => {
      assert.equal(
        error.message,
        SAY.say("board contract", "needs an id", "board contract --help"),
      );
      return true;
    },
  );
});

test("an unknown group keeps the same error shape (`✗ agentry_<group>:`)", async () => {
  await assert.rejects(
    () => runVerb("maybe", ["status"], {}),
    (error) => {
      assert.equal(error.message, '✗ agentry_maybe: unknown group "maybe"');
      return true;
    },
  );
});

test("route() is exit-pure: no process.exitCode side effect after any call", async () => {
  const before = process.exitCode;
  const root = mkBoard();
  await runVerb("board", ["status"], { root });
  await runVerb("board", ["check"], { root: mkBoard("evidence-board") });
  await assert.rejects(() => runVerb("board", ["contract"], { root }));
  assert.equal(process.exitCode, before);
});

test("both tools share runVerb: no private route calls in the tool files, none in index.js", () => {
  for (const [name, source, allowed] of [
    ["src/run.mjs", RUN, true],
    ["src/tools/board.mjs", BOARD, false],
  ]) {
    assert.ok(
      source.includes('from "../run.mjs"') || allowed,
      `${name} does not reach the seam through runVerb`,
    );
    assert.ok(!source.includes("vendor/scripts/board.mjs"), `${name} imports an entry script`);
    assert.ok(!source.includes("vendor/scripts/lane.mjs"), `${name} imports an entry script`);
    assert.ok(!source.includes("vendor/scripts/mem.mjs"), `${name} imports an entry script`);
    assert.ok(!source.includes("vendor/scripts/init.mjs"), `${name} imports an entry script`);
    if (allowed) {
      assert.ok(
        RUN.includes('import(new URL("../vendor/scripts/lib/cli/router.mjs", import.meta.url))'),
        "the seam dynamic-imports only the vendored router",
      );
      assert.equal(RUN.match(/import\(new URL/g)?.length, 1, "the seam has one dynamic import");
    } else {
      assert.ok(!/import\(/.test(BOARD), `${name} dynamic-imports`);
      assert.ok(!source.includes("router"), `${name} calls the router directly`);
    }
  }
});
