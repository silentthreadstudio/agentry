// Tests for the runVerb pin (all four tools route through the seam, never the router privately) and
// for the mem tools end to end: recall and search return the CLI's ranked rows in text and --json,
// stats counts, a write lands exactly the file the bare CLI's own invocation lands, and an unknown
// verb is the CLI's refusal verbatim. Offline, over a temp store with the same root-resolution env
// the CLI's offline tests swap (`mem-cli.test.mjs`'s mechanics). One concern per module: the mem
// group.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { memRead, memWrite } from "../src/tools/mem.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(HERE, "..", "vendor", "scripts");
const MEM = join(VENDOR, "mem.mjs");
const CLI_DIR = join(VENDOR, "lib", "memory", "cli");
const FACTS = (base) => join(base, ".agentry", "memory", "facts");
const SAY = await import(new URL("../vendor/scripts/lib/cli/help.mjs", import.meta.url));

const temp = [];
after(() => {
  for (const dir of temp) rmSync(dir, { recursive: true, force: true });
});
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "agentry-opencode-mem-"));
  temp.push(dir);
  return dir;
};
/** A store: its global base dir, and a project dir when asked for. */
const store = ({ project = false } = {}) => ({
  global: fresh(),
  project: project ? fresh() : null,
});

// Run the tool's execute against `s` with the roots' environment set around the call (the CLI reads
// its roots from exactly these), from a cwd outside any git repo so the cwd names no project store.
const ENV_KEYS = ["AGENTRY_GLOBAL_DIR", "CLAUDE_PROJECT_DIR", "AGENTRY_PROJECT_DIR"];
async function withRoots(s, run) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const cwd = process.cwd();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AGENTRY_GLOBAL_DIR = s.global;
  if (s.project) process.env.CLAUDE_PROJECT_DIR = s.project;
  process.chdir(tmpdir());
  try {
    return await run();
  } finally {
    process.chdir(cwd);
    for (const [k, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[k];
      else process.env[k] = value;
    }
  }
}

// The bare vendored mem CLI: one subprocess, the env the CLI reads its roots from set around it.
function bareCLI(s, ...args) {
  const env = { ...process.env, AGENTRY_GLOBAL_DIR: s.global };
  for (const k of ["CLAUDE_PROJECT_DIR", "AGENTRY_PROJECT_DIR"]) delete env[k];
  return spawnSync("node", [MEM, ...args], { encoding: "utf8", cwd: tmpdir(), env });
}

const firstFactFile = (factsDir) =>
  readdirSync(factsDir)
    .filter((f) => f.endsWith(".md"))
    .sort()[0];

// The two runs' own variance when the same memory is written twice: the record's id and wall clock;
// everything else (slug, frontmatter, body) must survive byte for byte.
const normalize = (text) =>
  text.replace(/g:[0-9A-Z]{26}/g, "<ID>").replace(/\d{4}-\d{2}-\d{2}T[\d:.]{8,}Z?/g, "<TIME>");

test("board and lane route through runVerb; mem spawns the vendored cli and imports no router", async () => {
  const lane = readFileSync(join(HERE, "..", "src", "tools", "lane.mjs"), "utf8");
  assert.ok(
    (lane.match(/runVerb\("(\w+)"/g) ?? []).length >= 2,
    "lane: both of its tools call runVerb",
  );
  assert.doesNotMatch(lane, /vendor\/scripts\/lib\/cli\/router/, "lane: no private route");
  const mem = readFileSync(join(HERE, "..", "src", "tools", "mem.mjs"), "utf8");
  assert.ok(
    mem.includes("spawnSync"),
    "mem: the survived-ghost store resolution spawns the vendor cli",
  );
  assert.doesNotMatch(mem, /vendor\/scripts\/lib\/cli\/router/, "mem: no private route");
  assert.match(mem, /CLAUDE_PROJECT_DIR: root/, "mem: the spawned env names the store's root");
});

test("root is where the CLI runs and where the store resolves for the call: the description says both", () => {
  const description = (tool) => tool.input.properties.root.description;
  for (const tool of [memRead, memWrite]) {
    assert.match(
      description(tool),
      /defaults to the location that loaded this plugin\./,
      tool.name,
    );
    assert.match(description(tool), /the CLI resolves this session.s store under it/, tool.name);
    assert.match(description(tool), /never the service process's\.$/, tool.name);
  }
});

test("a write with the root set lands in that root's own store, not the running repo's", async () => {
  const root = fresh(); // the workspace the plugin was loaded from (what setup binds as the default)
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of ENV_KEYS) delete process.env[k]; // the CLI resolves the store from the explicit root, never the env
    const out = await memWrite.execute(
      {
        verb: "write",
        words: [
          "--type",
          "learning",
          "--scope",
          "repo",
          "--subject",
          "q4 store",
          "--text",
          "the store resolves under the tool's root",
        ],
        root,
      },
      { sessionID: "ses_t", messageID: "msg_t", id: "prt_t" },
    );
    assert.match(out.content[0].text, /id:/);
    const dir = join(root, ".agentry", "memory", "facts");
    const saw = existsSync(dir) ? readdirSync(dir) : [];
    assert.ok(
      saw.some((f) => f.includes("the-store-resolves")),
      `expected the fact under ${dir}, saw: ${saw.join(", ")}, cwd=${process.cwd()}, env=${JSON.stringify(process.env.AGENTRY_PROJECT_DIR)}`,
    );
  } finally {
    for (const [k, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[k];
      else process.env[k] = value;
    }
  }
});

test("recall and search are the CLI's ranked rows, in text and --json, through the tool", async () => {
  const s = store();
  const seed = {
    verb: "write",
    words: ["--type", "gotcha", "--scope", "global", "--text", "the topaz build caches its output"],
  };
  const seeded = await withRoots(s, () => memWrite.execute(seed));
  assert.match(seeded.content[0].text, /^id: g:[0-9A-Z]{26}\naction: created$/);
  await withRoots(s, () =>
    memWrite.execute({
      ...seed,
      words: [...seed.words.slice(0, -1), "esbuild must mark node:sqlite external"],
    }),
  );

  const ask = { verb: "recall", query: "topaz build caches", root: undefined };
  const text = await withRoots(s, () => memRead.execute(ask));
  const textRows = text.content[0].text.split("\n");
  assert.match(textRows[0], /^memories\[0\]\.fact\.id: g:[0-9A-Z]{26}$/);
  assert.ok(textRows.includes("memories[0].fact.text: the topaz build caches its output"));
  assert.ok(
    textRows.some((l) => /^memories\[0\]\.score: \d/.test(l)),
    textRows.join("\n"),
  );

  const json = await withRoots(s, () => memRead.execute({ ...ask, json: true }));
  const { id } = JSON.parse(json.content[0].text).memories[0].fact;
  const found = await withRoots(s, () =>
    memRead.execute({ verb: "search", query: "topaz", json: true }),
  );
  assert.deepEqual(JSON.parse(found.content[0].text), {
    results: [
      { id, snippet: "the topaz build caches its output", type: "gotcha", scope: "global" },
    ],
  });
});

test("stats counts through the tool, and limit is the CLI's number", async () => {
  const s = store();
  const seed = {
    verb: "write",
    words: ["--type", "gotcha", "--scope", "global", "--text", "first fact"],
  };
  await withRoots(s, () => memWrite.execute(seed));
  await withRoots(s, () =>
    memWrite.execute({
      ...seed,
      words: ["--type", "decision", "--scope", "global", "--text", "second fact"],
    }),
  );
  const text = await withRoots(s, () => memRead.execute({ verb: "stats" }));
  assert.deepEqual(
    text.content[0].text,
    [
      "facts: 2",
      "episodes: 0",
      "active: 2",
      "superseded: 0",
      "archived: 0",
      "undistilled: 0",
      "byType.gotcha: 1",
      "byType.decision: 1",
      "readErrors: none",
    ].join("\n"),
  );
  const json = await withRoots(s, () => memRead.execute({ verb: "stats", json: true }));
  assert.deepEqual(
    JSON.parse(json.content[0].text),
    JSON.parse(bareCLI(s, "stats", "--json").stdout),
  );
  const one = await withRoots(s, () =>
    memRead.execute({ verb: "recall", query: "fact", limit: 1, json: true }),
  );
  assert.equal(JSON.parse(one.content[0].text).memories.length, 1);
});

test("a write through the tool lands the file the bare CLI's own invocation lands", async () => {
  const [a, b] = [store(), store()];
  const args = [
    "--type",
    "gotcha",
    "--scope",
    "global",
    "--text",
    "esbuild must mark node:sqlite external",
    "--why",
    "bundles break: sqlite is a builtin",
    "--tags",
    "build",
  ];
  const wrote = await withRoots(a, () => memWrite.execute({ verb: "write", words: args }));
  assert.match(wrote.content[0].text, /^id: g:[0-9A-Z]{26}\naction: created$/);
  const bare = bareCLI(b, "write", ...args, "--json");
  assert.equal(bare.status, 0, bare.stdout || bare.stderr);

  const inProc = FACTS(a.global);
  const spawned = FACTS(b.global);
  const [toolFile, cliFile] = [firstFactFile(inProc), firstFactFile(spawned)];
  assert.ok(existsSync(join(inProc, toolFile)) && existsSync(join(spawned, cliFile)));
  const slugOf = (file) => file.replace(/-[0-9A-Z]{26}\.md$/, ".md");
  assert.equal(
    slugOf(toolFile),
    slugOf(cliFile),
    "the slug matches; the record's own id randomness aside",
  );
  assert.equal(
    normalize(readFileSync(join(inProc, toolFile), "utf8")),
    normalize(readFileSync(join(spawned, cliFile), "utf8")),
    "frontmatter and body match but the store's own id and stamps",
  );
});

test("an unknown verb is the CLI's refusal with the help-steer line, verbatim", async () => {
  const subs = readdirSync(CLI_DIR).map((f) => f.replace(/\.mjs$/, ""));
  await assert.rejects(
    () => withRoots(store(), () => memRead.execute({ verb: "bogus" })),
    (error) => {
      assert.equal(
        error.message,
        SAY.say(
          "mem",
          `unknown subcommand "bogus" (subcommands: ${subs.join(", ")})`,
          "mem --help",
        ),
      );
      return true;
    },
  );
  await assert.rejects(
    () => withRoots(store(), () => memWrite.execute({ verb: "bogus" })),
    (error) => {
      assert.ok(error.message.includes('unknown subcommand "bogus"'));
      return true;
    },
  );
});

test("a missing or empty verb is the tool's own refusal, not a TypeError", async () => {
  for (const tool of [memRead, memWrite]) {
    for (const input of [{}, { verb: "" }, undefined]) {
      await assert.rejects(
        () => withRoots(store(), () => tool.execute(input)),
        (error) => {
          assert.ok(error.message.startsWith("✗ agentry_mem:"), error.message);
          return true;
        },
      );
    }
  }
});

test("with no root the inherited project env still names the store the write lands in", async () => {
  const s = store({ project: true });
  const words = ["--type", "learning", "--scope", "repo", "--subject", "env", "--text", "kept env"];
  await withRoots(s, () => memWrite.execute({ verb: "write", words }));
  assert.ok(readdirSync(FACTS(s.project)).some((f) => f.endsWith(".md")));
});
