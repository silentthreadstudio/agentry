// Tests for lib/process/spec/models.mjs's contract side (field 96): a step's model marker, then the
// contract's bullet, then the workflow file's `models`, each named as its source, and the prose hint
// `exec start` prints. The last tests run `lane exec start` on a temp repo to see the printed lines.
// Run: node --test plugin/scripts/test/models.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { modelFor, proseModelHint } from "../lib/process/spec/models.mjs";
import { stepsOf } from "../lib/process/steps.mjs";
import { commitFile, git, gitEnv } from "./git-repo.mjs";
import { writeSpec } from "./spec-files.mjs";

const SPEC = { models: { build: "haiku", verify: { default: "sonnet" } } };
const STEPPED = [
  "- **T1**: owns `out.txt`.",
  "- **Model:** sonnet",
  "- **Steps:**",
  "  1. Parse it",
  "  2. Wire it (model: opus) → owner OK",
  "  3. Ship it",
].join("\n");
const { steps } = stepsOf(STEPPED);

test("a step's model marker wins for its run's build dispatch, named as the step", () => {
  assert.deepEqual(modelFor(SPEC, "build", { contract: STEPPED, steps, stepRun: [1, 2] }), {
    model: "opus",
    from: "step 2",
  });
});

test("a run with no marked step takes the contract's bullet, then models.build", () => {
  assert.deepEqual(modelFor(SPEC, "build", { contract: STEPPED, steps, stepRun: [3, 3] }), {
    model: "sonnet",
    from: "contract",
  });
  const bare = "- **T1**: owns `out.txt`.\n- **Steps:**\n  1. Parse it\n  2. Ship it";
  assert.deepEqual(
    modelFor(SPEC, "build", { contract: bare, steps: stepsOf(bare).steps, stepRun: [1, 2] }),
    { model: "haiku", from: "models.build" },
  );
});

test("a step's model marker never names the verifier's model", () => {
  assert.deepEqual(modelFor(SPEC, "verify", { contract: STEPPED, steps, stepRun: [1, 2] }), {
    model: "sonnet",
    from: "models.verify.default",
  });
});

test("a contract with no markers resolves exactly as before", () => {
  const plain = "- **T1**: owns `out.txt`. Accept: out.txt exists.";
  assert.deepEqual(modelFor(SPEC, "build", { contract: plain }), {
    model: "haiku",
    from: "models.build",
  });
  assert.deepEqual(modelFor(SPEC, "build", { contract: plain, steps: [], stepRun: null }), {
    model: "haiku",
    from: "models.build",
  });
});

test("the prose hint: a model word near 'model' or a role word, with no marker or bullet", () => {
  const prose = "- **T1**: owns `out.txt`. The builder should run on Opus for this one.";
  assert.equal(
    proseModelHint(prose),
    "the contract mentions opus in prose: add - **Model:** opus (or a step marker) to make it the dispatch",
  );
  assert.match(proseModelHint("- **T1**: use the haiku model here.") ?? "", /mentions haiku/);
});

test("no prose hint when a bullet or a step marker names the model, or the word is far from any role word", () => {
  assert.equal(proseModelHint("- **T1**: the builder runs opus.\n- **Model:** opus"), null);
  assert.equal(proseModelHint("- **T1**: verify on opus.\n- **Model (verify):** opus"), null);
  const marked = "- **T1**: the builder runs opus.\n- **Steps:**\n  1. a (model: opus)\n  2. b";
  assert.equal(proseModelHint(marked, stepsOf(marked).steps), null);
  assert.equal(
    proseModelHint("- **T1**: a fable, one two three four five six seven, then the build."),
    null,
  );
  assert.equal(proseModelHint("```\nthe builder runs opus\n```"), null);
});

test("no prose hint from a model word inside a code span or a path", () => {
  assert.equal(proseModelHint("- **T1**: owns `src/opus/model.ts`. Accept: it builds."), null);
  assert.equal(proseModelHint("- **T1**: the builder reads `model=haiku` from the config."), null);
  assert.equal(
    proseModelHint("- **T1**: owns src/opus/model.ts and models/sonnet.json for the build."),
    null,
  );
  assert.match(
    proseModelHint("- **T1**: owns `a.ts`; the builder runs opus.") ?? "",
    /mentions opus/,
  );
  // One long path token is read once: a 50k-character token takes no visible time.
  const started = Date.now();
  assert.equal(proseModelHint(`the builder runs ${"a/".repeat(25000)}opus`), null);
  assert.ok(Date.now() - started < 1000);
});

// ---- lane exec start: the printed lines ------------------------------------------------------------

const LANE = join(dirname(fileURLToPath(import.meta.url)), "..", "lane.mjs");
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
};
const EXEC_SPEC = {
  version: 1,
  name: "Models",
  root: "plan",
  kinds: {
    task: {
      label: "Task",
      at: { table: "BOARD.md", heading: "Tasks" },
      id: { column: "Task" },
      fields: {
        status: { column: "Status" },
        flag: { column: "Flag", type: "flag", mark: "x" },
      },
      status: { field: "status", values: { todo: "planned", doing: "active", done: "done" } },
      contract: { blocks: ["TASKS.md"] },
    },
  },
  rules: [{ rule: "ids-unique" }],
  lifecycle: {
    kind: "task",
    on: { dispatched: "doing", merged: "done" },
    write: { status: "status" },
  },
  models: { build: "haiku" },
};

function start(tasks, extra = {}, id = "T1") {
  const root = temp("models-repo-");
  const home = temp("models-home-");
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, ".agentry"));
  commitFile(root, ".gitignore", ".agentry/run/\n");
  commitFile(
    root,
    "plan/BOARD.md",
    `# Models\n\n## Tasks\n\n| Task | Status | Flag |\n| ---- | ------ | ---- |\n| ${id}   | todo   |      |\n`,
  );
  commitFile(root, "plan/TASKS.md", `# Tasks\n\n${tasks}\n`);
  writeSpec(join(root, ".agentry"), { ...EXEC_SPEC, ...extra });
  git(root, "add", ".agentry");
  git(root, "commit", "-q", "-m", "add the process files");
  const run = (...args) =>
    spawnSync("node", [LANE, "exec", ...args, id, "--root", root], {
      encoding: "utf8",
      env: { ...gitEnv, HOME: home },
    });
  const json = run("start", "--json");
  assert.equal(json.status, 0, json.stderr);
  return { json: JSON.parse(json.stdout), text: run("show").stdout };
}

test("exec start: a step's markers name the model and the agent, each as `step N`", () => {
  const { json, text } = start(
    "- **T1**: owns `out.txt`. Accept: out.txt exists.\n  - **Steps:**\n    1. Draw it (model: opus, agent: designer) → owner OK\n    2. Ship it",
  );
  assert.deepEqual([json.model, json.modelFrom], ["opus", "step 1"]);
  assert.deepEqual(json.dispatch, { agent: "designer", why: "step 1 names it", from: "step 1" });
  assert.match(text, /^model: opus \(step 1\)$/m);
  assert.match(text, /"from": "step 1"/);
});

test("exec start: the contract's Model and Agent bullets, named as the contract", () => {
  const { json, text } = start(
    "### T1 · Bullets\n\n- **Owns:** `out.txt`\n- **Model:** sonnet\n- **Agent:** designer\n- **Acceptance:** out.txt exists.",
  );
  assert.deepEqual([json.model, json.modelFrom], ["sonnet", "contract"]);
  assert.deepEqual(json.dispatch, {
    agent: "designer",
    why: "the contract names it",
    from: "contract",
  });
  assert.match(text, /^model: sonnet \(contract\)$/m);
});

test("exec start: a contract with no markers dispatches as before, and prose naming a model prints the hint", () => {
  const plain = start("- **T1**: owns `out.txt`. Accept: out.txt exists.");
  assert.deepEqual(plain.json.dispatch, {
    agent: "implementer",
    why: "no owned path is UI-shaped",
  });
  assert.deepEqual([plain.json.model, plain.json.modelFrom], ["haiku", "models.build"]);
  assert.equal(plain.json.hint, undefined);
  const prose = start(
    "- **T1**: owns `out.txt`; the builder runs on opus. Accept: out.txt exists.",
  );
  assert.deepEqual([prose.json.model, prose.json.modelFrom], ["haiku", "models.build"]);
  assert.equal(
    prose.json.hint,
    "the contract mentions opus in prose: add - **Model:** opus (or a step marker) to make it the dispatch",
  );
});

test("exec start: the route's unused-ui warning sees a designer named by a step or the Agent bullet", () => {
  const route = {
    exec: { verify: "flagged" },
    models: { verify: { ui: "ui-m", flagged: "flag-m" } },
  };
  const unused = /! models\.verify\.ui is unused/;
  const stepped = start(
    "- **T1**: owns `out.txt`. Accept: out.txt exists.\n  - **Steps:**\n    1. Draw it (agent: designer)\n    2. Ship it",
    route,
  );
  assert.match(stepped.json.route, unused);
  const bullet = start(
    "### T1 · Bullet\n\n- **Owns:** `out.txt`\n- **Agent:** designer\n- **Acceptance:** out.txt exists.",
    route,
  );
  assert.match(bullet.json.route, unused);
  const plain = start("- **T1**: owns `out.txt`. Accept: out.txt exists.", route);
  assert.doesNotMatch(plain.json.route, unused);
});
