// `agentry mem <verb>`: the 12 verbs over a store in a temp dir, through the router (in this process, with the
// environment the verb reads its roots from set around each call) and, for the entry points, through the real
// processes. Exit 0 = ok, 1 = refused (the reason is printed), 2 = usage.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { route } from "../lib/cli/router.mjs";
import { MemoryService } from "../lib/memory/application/memory-service.mjs";
import { SqliteTextIndex } from "../lib/memory/persistence/db-index.mjs";
import { MarkdownFileStore } from "../lib/memory/persistence/file-store.mjs";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(SCRIPTS, "lib", "memory", "cli");
const VERBS = [
  "consolidate",
  "distill",
  "episode",
  "feedback",
  "forget",
  "recall",
  "recover",
  "resync",
  "search",
  "stats",
  "update",
  "write",
];
const ENV_KEYS = ["AGENTRY_GLOBAL_DIR", "CLAUDE_PROJECT_DIR", "AGENTRY_PROJECT_DIR"];

const fresh = () => mkdtempSync(join(tmpdir(), "agentry-mem-cli-"));

/** A store: its global base dir, and a project dir when asked for. */
const store = ({ project = false } = {}) => ({
  global: fresh(),
  project: project ? fresh() : null,
});

/** Run `mem <argv>` against `s` through the router, with the roots' environment set around the call. It
 *  runs in the temp dir, outside any git repo, so the cwd names no project root of its own. */
async function mem(s, ...argv) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const cwd = process.cwd();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AGENTRY_GLOBAL_DIR = s.global;
  if (s.project) process.env.CLAUDE_PROJECT_DIR = s.project;
  process.chdir(tmpdir());
  try {
    return await route(argv, { dir: DIR, name: "mem" });
  } finally {
    process.chdir(cwd);
    for (const k of ENV_KEYS)
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
  }
}

/** The JSON a verb printed with --json (asserting it succeeded). */
async function ok(s, ...argv) {
  const r = await mem(s, ...argv, "--json");
  assert.equal(r.exit, 0, r.out);
  return JSON.parse(r.out);
}

/** The error envelope a verb printed with --json (asserting it was refused, exit 1). */
async function refused(s, ...argv) {
  const r = await mem(s, ...argv, "--json");
  assert.equal(r.exit, 1, r.out);
  return JSON.parse(r.out).error;
}

const service = (s, now) => {
  const roots = {
    global: join(s.global, ".agentry", "memory"),
    project: s.project && join(s.project, ".agentry", "memory"),
  };
  const svc = new MemoryService(new MarkdownFileStore(roots), new SqliteTextIndex(), roots, now);
  svc.load();
  return svc;
};

/** An archived fact in `s`, by the real decay path. */
function archivedFact(s) {
  let clock = 1_000;
  const svc = service(s, () => clock);
  const { id } = svc.write({
    type: "gotcha",
    scope: "global",
    text: `archive target ${Math.random()}`,
  });
  for (let strike = 0; strike < 4; strike++) {
    clock += 1_000;
    svc.feedback({ recalled: [id], used: [], outcome: "pass" });
  }
  return id;
}

const GOTCHA = ["write", "--type", "gotcha", "--scope", "global", "--text"];

test("the verbs are the 12 memory tools, each with a help that lists its flags", async () => {
  const index = await route(["--help"], { dir: DIR, name: "mem" });
  assert.equal(index.exit, 0);
  for (const verb of VERBS) {
    assert.match(index.out, new RegExp(`^  ${verb}  `, "m"), verb);
    const help = await route([verb, "--help"], { dir: DIR, name: "mem" });
    assert.equal(help.exit, 0, verb);
    assert.match(help.out, new RegExp(`usage: mem ${verb}`), verb);
    assert.match(help.out, /--json/, verb);
    assert.match(help.out, /example:\n {2}agentry mem /, verb);
  }
});

// ── output ──────────────────────────────────────────────────────────────────────────────────────────

test("default output is key: value, one line per value", async () => {
  const s = store();
  const written = await mem(s, ...GOTCHA, "esbuild must mark node:sqlite external");
  assert.equal(written.exit, 0);
  const lines = written.out.split("\n");
  assert.match(lines[0], /^id: g:[0-9A-Z]{26}$/);
  assert.equal(lines[1], "action: created");

  const stats = await mem(s, "stats");
  assert.deepEqual(stats.out.split("\n"), [
    "facts: 1",
    "episodes: 0",
    "active: 1",
    "superseded: 0",
    "archived: 0",
    "undistilled: 0",
    "byType.gotcha: 1",
    "readErrors: none",
  ]);
});

test("lists of objects are indexed, lists of scalars joined, and a multi-line value is one JSON string", async () => {
  const s = store();
  await mem(
    s,
    ...GOTCHA,
    "the topaz build caches its output",
    "--tags",
    "build",
    "--tags",
    "cache",
    "--why",
    "first\nsecond",
  );
  const recall = await mem(s, "recall", "--query", "topaz build");
  assert.equal(recall.exit, 0);
  const lines = recall.out.split("\n");
  assert.ok(lines.includes("memories[0].fact.text: the topaz build caches its output"));
  assert.ok(lines.includes("memories[0].fact.tags: build, cache"));
  assert.ok(lines.includes('memories[0].fact.why: "first\\nsecond"'));
  assert.ok(lines.some((l) => /^memories\[0\]\.score: /.test(l)));
});

test("--json prints the result as one JSON object", async () => {
  const s = store();
  const { id } = await ok(s, ...GOTCHA, "a fact to search for");
  const found = await ok(s, "search", "--query", "search");
  assert.deepEqual(found, {
    results: [{ id, snippet: "a fact to search for", type: "gotcha", scope: "global" }],
  });
});

// ── the verbs ───────────────────────────────────────────────────────────────────────────────────────

test("every verb's happy path exits 0 with the shape the MCP tool returned", async () => {
  const s = store();
  const fact = await ok(s, ...GOTCHA, "seed fact for happy paths");
  assert.equal(fact.action, "created");
  const { id: factId } = fact;
  assert.ok(
    (await ok(s, "write", "--type", "decision", "--scope", "global", "--text", "another fact")).id,
  );

  assert.equal(
    (await ok(s, "recall", "--query", "seed fact happy paths")).memories[0].fact.id,
    factId,
  );
  assert.ok(Array.isArray((await ok(s, "search", "--query", "seed fact")).results));
  assert.deepEqual(await ok(s, "update", "--id", factId, "--confidence", "0.9"), {
    id: factId,
    updated: true,
  });
  assert.ok(
    (
      await ok(s, "feedback", "--recalled", factId, "--used", factId, "--outcome", "pass")
    ).applied.includes(factId),
  );
  const { id: throwaway } = await ok(s, ...GOTCHA, "forget me");
  assert.deepEqual(await ok(s, "forget", "--id", throwaway), { forgotten: true, kind: "fact" });
  const { id: epId } = await ok(
    s,
    "episode",
    "--task",
    "t",
    "--shape",
    "decompose",
    "--outcome",
    "pass",
    "--lesson",
    "lesson text",
  );
  assert.ok(epId.startsWith("g:"));
  assert.equal((await ok(s, "stats")).episodes, 1);
  const { clusters } = await ok(s, "distill", "--mode", "list");
  assert.deepEqual(clusters, [
    { episodes: [epId], draftFacts: [{ type: "gotcha", text: "lesson text", provenance: [epId] }] },
  ]);
  assert.deepEqual((await ok(s, "distill", "--mode", "stamp", "--episode-ids", epId)).applied, [
    epId,
  ]);
  assert.deepEqual(await ok(s, "consolidate"), { proposals: [] });
  const resynced = await ok(s, "resync");
  assert.deepEqual(Object.keys(resynced).sort(), ["after", "before", "rebuilt"]);
  assert.deepEqual(await ok(s, "recover", "--id", archivedFact(s)), { recovered: true });
});

test("a near-duplicate write reinforces; --supersedes retires the named fact and skips that dedup", async () => {
  const s = store();
  const first = await ok(s, ...GOTCHA, "always use pnpm for installs in this repo");
  const again = await ok(s, ...GOTCHA, "always use pnpm for installs in this repo");
  assert.deepEqual(again, { id: first.id, action: "reinforced" });

  const next = await ok(
    s,
    ...GOTCHA,
    "always use pnpm for installs in this repo",
    "--supersedes",
    first.id,
  );
  assert.equal(next.action, "created");
  assert.equal("supersededMissing" in next, false);
  assert.equal((await ok(s, "stats")).superseded, 1);
});

test("a bogus --supersedes still writes and flags the link as a no-op; none leaves the field out", async () => {
  const s = store();
  const ghost = await ok(
    s,
    "write",
    "--type",
    "repo-fact",
    "--scope",
    "global",
    "--text",
    "new fact",
    "--supersedes",
    "g:GHOST",
  );
  assert.equal(ghost.action, "created");
  assert.equal(ghost.supersededMissing, "g:GHOST");
  const plain = await ok(
    s,
    "write",
    "--type",
    "repo-fact",
    "--scope",
    "global",
    "--text",
    "plain fact",
  );
  assert.equal("supersededMissing" in plain, false);
});

test("a repo-scope write goes to the project root with a p: id, and to the global root without one", async () => {
  const withProject = store({ project: true });
  const { id } = await ok(
    withProject,
    "write",
    "--type",
    "repo-fact",
    "--scope",
    "repo",
    "--text",
    "the lab repo pins pnpm",
  );
  assert.ok(id.startsWith("p:"));
  const dir = join(withProject.project, ".agentry", "memory", "facts");
  assert.equal(readdirSync(dir).length, 1);
  assert.equal(existsSync(join(withProject.global, ".agentry")), false);

  const alone = store();
  const lone = await ok(
    alone,
    "write",
    "--type",
    "repo-fact",
    "--scope",
    "repo",
    "--text",
    "the lab repo pins pnpm",
  );
  assert.ok(lone.id.startsWith("g:"));
});

test("a value that starts with a dash is given as --flag=value", async () => {
  const s = store();
  const { id } = await ok(
    s,
    "write",
    "--type",
    "gotcha",
    "--scope",
    "global",
    "--text=-leading dash",
  );
  const found = await ok(s, "search", "--query", "leading");
  assert.equal(found.results[0].id, id);
  assert.equal(found.results[0].snippet, "-leading dash");
});

test("list flags repeat, one item each, taken as given", async () => {
  const s = store();
  await ok(
    s,
    ...GOTCHA,
    "tagged fact",
    "--tags",
    "a,b",
    "--tags",
    "c d",
    "--provenance",
    "p:1",
    "--provenance",
    "p:2",
  );
  const { memories } = await ok(s, "recall", "--query", "tagged");
  assert.deepEqual(memories[0].fact.tags, ["a,b", "c d"]);
  assert.deepEqual(memories[0].fact.provenance, ["p:1", "p:2"]);
});

test("update --tags-clear removes the tags; with --tags it is refused; an empty --tags is not a clear", async () => {
  const s = store();
  const { id } = await ok(s, ...GOTCHA, "a tagged fact", "--tags", "a", "--tags", "b");
  assert.deepEqual(await ok(s, "update", "--id", id, "--tags-clear"), { id, updated: true });
  assert.deepEqual((await ok(s, "recall", "--query", "tagged fact")).memories[0].fact.tags, []);
  const both = await refused(s, "update", "--id", id, "--tags", "x", "--tags-clear");
  assert.equal(both.code, "bad-input");
  const raw = readFileSync(
    join(
      s.global,
      ".agentry",
      "memory",
      "facts",
      readdirSync(join(s.global, ".agentry", "memory", "facts"))[0],
    ),
    "utf8",
  );
  assert.match(raw, /^tags: \[\]$/m);
  assert.match((await mem(s, "update", "--help")).out, /--tags-clear +remove all/);
});

test("recall --mode prime is the warm set: top facts and recent episodes; no query and no mode is empty", async () => {
  const s = store();
  await ok(s, ...GOTCHA, "a fact for the warm set");
  await ok(s, "episode", "--task", "t", "--shape", "s", "--outcome", "o");
  const prime = await ok(s, "recall", "--mode", "prime");
  assert.equal(prime.memories.length, 1);
  assert.equal(prime.episodes.length, 1);
  assert.deepEqual(await ok(s, "recall"), { memories: [] });
});

// ── refusals: exit 1, the reason printed, nothing changed ─────────────────────────────────────────────────

test("update, forget and recover on a missing id: not-found, the same envelope from each", async () => {
  const s = store();
  const missing = "g:NONEXISTENT";
  const u = await refused(s, "update", "--id", missing);
  const f = await refused(s, "forget", "--id", missing);
  const r = await refused(s, "recover", "--id", missing);
  assert.equal(u.code, "not-found");
  assert.deepEqual(u, f);
  assert.deepEqual(u, r);
  assert.ok(u.why.includes(missing));
});

test("the text of a refusal is the error line: what failed, why, and the fix", async () => {
  const r = await mem(store(), "recover", "--id", "g:NOPE");
  assert.equal(r.exit, 1);
  assert.match(
    r.out,
    /^✗ mem recover: not-found: No record was found for id "g:NOPE"\. → Pass the id/,
  );
  assert.equal(r.out.split("\n").length, 1);
});

test("recover on an existing non-archived fact: invalid-state, naming the actual status", async () => {
  const s = store();
  const { id } = await ok(
    s,
    "write",
    "--type",
    "decision",
    "--scope",
    "global",
    "--text",
    "an active fact, not archived",
  );
  const env = await refused(s, "recover", "--id", id);
  assert.equal(env.code, "invalid-state");
  assert.ok(env.why.includes("active"));
  assert.ok(env.why.includes("archived") || env.fix.includes("archived"));
});

test("update --status active on an archived fact points at recover, and the fact stays archived", async () => {
  const s = store();
  const id = archivedFact(s);
  const env = await refused(s, "update", "--id", id, "--status", "active");
  assert.equal(env.code, "invalid-state");
  assert.ok(env.why.includes("archived"));
  assert.ok(env.fix.includes("mem recover"));
  assert.equal((await ok(s, "stats")).archived, 1);
});

test("update --status active on a superseded fact points at write, and the fact stays superseded", async () => {
  const s = store();
  const old = await ok(
    s,
    "write",
    "--type",
    "decision",
    "--scope",
    "global",
    "--text",
    "builds run on node 22",
  );
  await ok(
    s,
    "write",
    "--type",
    "decision",
    "--scope",
    "global",
    "--text",
    "builds run on node 24",
    "--supersedes",
    old.id,
  );
  const env = await refused(s, "update", "--id", old.id, "--status", "active");
  assert.equal(env.code, "invalid-state");
  assert.ok(env.why.includes("superseded"));
  assert.ok(env.fix.includes("mem write"));
  assert.equal((await ok(s, "stats")).superseded, 1);
});

test("update refuses a cross-root scope and a self-supersede, as bad-input naming the field", async () => {
  const s = store({ project: true });
  const { id } = await ok(
    s,
    "write",
    "--type",
    "repo-fact",
    "--scope",
    "repo",
    "--text",
    "the lab repo pins pnpm",
  );
  const scope = await refused(s, "update", "--id", id, "--scope", "user");
  assert.equal(scope.code, "bad-input");
  assert.ok(scope.why.includes('"scope"'));
  const self = await refused(s, "update", "--id", id, "--supersedes", id);
  assert.equal(self.code, "bad-input");
  assert.ok(self.why.includes('"supersedes"'));
});

test("a blank id is bad-input on update, forget and recover, and the fix names the field", async () => {
  const s = store();
  for (const verb of ["update", "forget", "recover"]) {
    const env = await refused(s, verb, "--id", "   ");
    assert.equal(env.code, "bad-input", verb);
    assert.ok(env.fix.includes("id"), verb);
  }
});

test("feedback with one good and one bogus id applies the good and lists the skipped with its reason", async () => {
  const s = store();
  const { id } = await ok(s, ...GOTCHA, "a real recalled fact");
  const data = await ok(
    s,
    "feedback",
    "--recalled",
    id,
    "--recalled",
    "g:BOGUS",
    "--used",
    id,
    "--outcome",
    "pass",
  );
  assert.deepEqual(data.applied, [id]);
  assert.equal(data.skipped.length, 1);
  assert.equal(data.skipped[0].id, "g:BOGUS");
  assert.ok(data.skipped[0].reason.length > 0);
});

test("feedback with only invalid ids is a not-found naming each id", async () => {
  const env = await refused(
    store(),
    "feedback",
    "--recalled",
    "g:NOPE1",
    "--recalled",
    "g:NOPE2",
    "--outcome",
    "pass",
  );
  assert.equal(env.code, "not-found");
  assert.ok(env.why.includes('"g:NOPE1"') && env.why.includes('"g:NOPE2"'));
});

test("feedback moves a fact as the rules say: used and passed boosts, unused four times archives", async () => {
  const s = store();
  const { id } = await ok(s, ...GOTCHA, "a fact the run cites");
  await ok(s, "feedback", "--used", id, "--outcome", "pass");
  const boosted = (await ok(s, "recall", "--query", "fact run cites")).memories[0].fact;
  assert.equal(boosted.usefulness, 1);
  assert.equal(boosted.confidence, 0.75);
  const lone = await ok(s, ...GOTCHA, "a fact nobody ever uses");
  for (let strike = 0; strike < 4; strike++)
    await ok(s, "feedback", "--recalled", lone.id, "--outcome", "pass");
  assert.equal((await ok(s, "stats")).archived, 1);
});

test("distill stamp: a good and a bogus id stamp the good one; only bogus ids are a not-found", async () => {
  const s = store();
  const { id } = await ok(
    s,
    "episode",
    "--task",
    "t",
    "--shape",
    "s",
    "--outcome",
    "pass",
    "--lesson",
    "l",
  );
  const data = await ok(
    s,
    "distill",
    "--mode",
    "stamp",
    "--episode-ids",
    id,
    "--episode-ids",
    "g:BOGUS_EP",
  );
  assert.deepEqual(data.applied, [id]);
  assert.equal(data.skipped[0].id, "g:BOGUS_EP");
  assert.equal((await ok(s, "stats")).undistilled, 0);
  assert.equal(
    (await refused(s, "distill", "--mode", "stamp", "--episode-ids", "g:NOPE")).code,
    "not-found",
  );
});

test("consolidate proposes a skill for a tag that recurs across useful facts, and installs nothing", async () => {
  const s = store();
  const ids = [];
  for (const text of [
    "pnpm is the package manager here",
    "run pnpm install before tests",
    "pnpm workspaces share one lockfile",
  ])
    ids.push((await ok(s, ...GOTCHA, text, "--tags", "pnpm")).id);
  for (const id of ids) await ok(s, "feedback", "--used", id, "--outcome", "pass");
  for (const id of ids) await ok(s, "feedback", "--used", id, "--outcome", "pass");
  const { proposals } = await ok(s, "consolidate");
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].pattern, "pnpm");
  assert.deepEqual(proposals[0].supportingMemoryIds.sort(), ids.sort());
  assert.deepEqual((await ok(s, "consolidate", "--min-recurrence", "4")).proposals, []);
});

test("an unexpected failure is the generic internal refusal, with no path or stack in it", async () => {
  const file = join(fresh(), "not-a-dir");
  writeFileSync(file, "a file where the store's base dir should be");
  const r = await mem({ global: file, project: null }, ...GOTCHA, "cannot be stored", "--json");
  assert.equal(r.exit, 1);
  const env = JSON.parse(r.out).error;
  assert.equal(env.code, "internal");
  assert.ok(!r.out.includes(file), "no path leaks");
  assert.ok(!r.out.includes("ENOTDIR"), "no error text leaks");
});

test("a corrupt store file is listed in stats.readErrors; stats stays a success", async () => {
  const s = store();
  await ok(s, ...GOTCHA, "a healthy fact");
  const facts = join(s.global, ".agentry", "memory", "facts");
  mkdirSync(facts, { recursive: true });
  writeFileSync(
    join(facts, "corrupt-record.md"),
    "---\nthis: is: not: valid: yaml: frontmatter\n---\nbody\n",
  );
  writeFileSync(join(facts, "bad.md"), "---\nbroken yaml ::: [\n---\nx\n");

  const stats = await ok(s, "stats");

  assert.equal(stats.facts, 1);
  assert.deepEqual(stats.readErrors.map((e) => [e.kind, e.file]).sort(), [
    ["facts", "bad.md"],
    ["facts", "corrupt-record.md"],
  ]);
  for (const e of stats.readErrors) assert.ok(e.reason.length > 0);
  const text = (await mem(s, "stats")).out;
  assert.match(text, /^readErrors\[0\]\.file: (bad|corrupt-record)\.md$/m);
});

// ── usage: exit 2 ───────────────────────────────────────────────────────────────────────────────────

test("a missing, unknown or malformed option is a usage error, exit 2, and nothing is written", async () => {
  const s = store();
  const usage = [
    [["write", "--scope", "global", "--text", "x"], /--type is required/],
    [
      ["write", "--type", "idea", "--scope", "global", "--text", "x"],
      /--type must be one of gotcha, decision/,
    ],
    [["write", "--type", "gotcha", "--scope", "global"], /--text is required/],
    [["write", "--type", "gotcha", "--scope", "global", "--text"], /--text needs a value/],
    [
      ["write", "--type", "gotcha", "--scope", "global", "--text", "a", "--text", "b"],
      /--text was given twice/,
    ],
    [
      ["write", "--type", "gotcha", "--scope", "global", "--text", "a", "--nope"],
      /unknown option "--nope"/,
    ],
    [
      ["write", "--type", "gotcha", "--scope", "global", "--text", "a", "extra"],
      /unexpected argument "extra"/,
    ],
    [["recall", "--limit", "0"], /--limit must be at least 1/],
    [["recall", "--limit", "2.5"], /--limit must be a whole number/],
    [["recall", "--limit", "many"], /--limit must be a whole number, not "many"/],
    [["recall", "--mode", "deep"], /--mode must be one of task, prime/],
    [["update", "--id", "g:1", "--confidence=1.5"], /--confidence must be at most 1/],
    [["update", "--id", "g:1", "--confidence=-0.5"], /--confidence must be at least 0/],
    [
      ["update", "--id", "g:1", "--status", "archived"],
      /--status must be one of active, superseded/,
    ],
    [["feedback", "--used", "g:1"], /--outcome is required/],
    [["feedback", "--outcome", "maybe"], /--outcome must be one of pass, fail/],
    [["distill"], /--mode is required/],
    [
      ["episode", "--task", "t", "--shape", "s", "--outcome", "o", "--retries", "-1"],
      /unknown option "-1"/,
    ],
    [
      ["episode", "--task", "t", "--shape", "s", "--outcome", "o", "--retries=-1"],
      /--retries must be at least 0/,
    ],
    [["consolidate", "--min-usefulness", "lots"], /--min-usefulness must be a number/],
    [["search"], /--query is required/],
    [["stats", "now"], /unexpected argument "now"/],
  ];
  for (const [argv, why] of usage) {
    const r = await mem(s, ...argv);
    assert.equal(r.exit, 2, argv.join(" "));
    assert.match(r.out, why, argv.join(" "));
    assert.match(r.out, /→ (agentry )?mem \w+ --help$/, argv.join(" "));
  }
  assert.equal((await ok(s, "stats")).facts, 0);
  assert.equal((await mem(s, "nope")).exit, 2);
});

// ── the real processes ─────────────────────────────────────────────────────────────────────────────────

const PLUGIN = join(SCRIPTS, "..");
// Spawned in `cwd` (default the store's global dir, outside any git repo) with `projectEnv` as its env.
function spawn(bin, s, ...args) {
  const { cwd = s.global, projectEnv = {} } = typeof args[0] === "object" ? args.shift() : {};
  const env = { ...process.env, AGENTRY_GLOBAL_DIR: s.global };
  for (const k of ["CLAUDE_PROJECT_DIR", "AGENTRY_PROJECT_DIR"]) delete env[k];
  Object.assign(env, projectEnv);
  const file = bin === "bin" ? join(PLUGIN, "bin", "agentry") : join(SCRIPTS, "mem.mjs");
  return spawnSync(process.execPath, [file, ...(bin === "bin" ? ["mem"] : []), ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
}

// ── which project store a call opens ─────────────────────────────────────────────────────

const sh = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });

/** A git repo with one commit and a linked worktree beside it: { main, worktree }. */
function repoWithWorktree() {
  const main = fresh();
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"],
    ["worktree", "add", "-q", "-b", "lane", join(main, "wt")],
  ])
    assert.equal(sh(main, ...args).status, 0, args.join(" "));
  return { main, worktree: join(main, "wt") };
}

/** The `--scope repo` fact a spawned `mem write` made, and the store dir it landed in. */
function writeRepoFact(s, opts) {
  const write = ["write", "--type", "gotcha", "--scope", "repo", "--text", "where am I", "--json"];
  const r = spawn("script", s, opts, ...write);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout).id;
}
const factsIn = (dir) => {
  const facts = join(dir, ".agentry", "memory", "facts");
  return existsSync(facts) ? readdirSync(facts).length : 0;
};

test("from a lane worktree, a repo fact goes to the main checkout's store", () => {
  const s = store();
  const { main, worktree } = repoWithWorktree();
  assert.match(writeRepoFact(s, { cwd: worktree }), /^p:/);
  assert.equal(factsIn(main), 1);
  assert.equal(factsIn(worktree), 0, "never a store inside the worktree");
});

test("from the main checkout, the repo fact lands there and a worktree call reads it back", () => {
  const s = store();
  const { main, worktree } = repoWithWorktree();
  assert.match(writeRepoFact(s, { cwd: main }), /^p:/);
  assert.equal(factsIn(main), 1);
  const stats = JSON.parse(spawn("script", s, { cwd: worktree }, "stats", "--json").stdout);
  assert.equal(stats.facts, 1);
});

test("a project dir in the env wins over the cwd's repo", () => {
  const s = store();
  const { main, worktree } = repoWithWorktree();
  const elsewhere = fresh();
  for (const key of ["CLAUDE_PROJECT_DIR", "AGENTRY_PROJECT_DIR"]) {
    assert.match(writeRepoFact(s, { cwd: worktree, projectEnv: { [key]: elsewhere } }), /^p:/);
  }
  assert.equal(factsIn(elsewhere), 1, "the same text twice is one fact");
  assert.equal(factsIn(main), 0);
});

test("outside any git repo there is no project root: a repo fact goes to the global store", () => {
  const s = store();
  const outside = fresh();
  assert.match(writeRepoFact(s, { cwd: outside }), /^g:/);
  assert.equal(factsIn(s.global), 1);
  assert.equal(factsIn(outside), 0);
});

test("agentry mem is scripts/mem.mjs: the same output and exit codes, through the bin", () => {
  const s = store();
  for (const args of [
    ["write", "--type", "gotcha", "--scope", "global", "--text", "through the bin", "--json"],
    ["stats", "--json"],
    ["recover", "--id", "g:NOPE"],
    ["write", "--type", "idea"],
  ]) {
    const via = spawn("bin", s, ...args);
    const direct = spawn("script", s, ...args);
    assert.equal(via.status, direct.status, args.join(" "));
    if (args[0] === "write" && args.includes("--json")) continue; // ids differ per call
    assert.equal(via.stdout, direct.stdout, args.join(" "));
    assert.equal(via.stderr, direct.stderr, args.join(" "));
  }
  assert.equal(spawn("bin", s, "recover", "--id", "g:NOPE").status, 1);
  assert.equal(spawn("bin", s, "write", "--type", "idea").status, 2);
  const stats = JSON.parse(spawn("bin", s, "stats", "--json").stdout);
  assert.equal(stats.facts, 1, "the same text twice is one fact, reinforced");
});

test("agentry --help names the mem group", () => {
  const help = spawnSync(process.execPath, [join(PLUGIN, "bin", "agentry"), "--help"], {
    encoding: "utf8",
  });
  assert.match(help.stdout, /agentry <board\|lane\|mem\|/);
  assert.match(help.stdout, /^ {2}mem {5}the memory store/m);
});

test("what a verb wrote is on disk as a Markdown file the next call reads", async () => {
  const s = store();
  const { id } = await ok(
    s,
    ...GOTCHA,
    "esbuild must mark node:sqlite external",
    "--why",
    "bundles break: sqlite is a builtin",
    "--tags",
    "build",
  );
  const dir = join(s.global, ".agentry", "memory", "facts");
  const [file] = readdirSync(dir);
  assert.equal(file, `esbuild-must-mark-node-sqlite-external-${id.slice(2)}.md`);
  const raw = readFileSync(join(dir, file), "utf8");
  assert.match(
    raw,
    /^---\nid: g:[0-9A-Z]{26}\ntype: gotcha\nscope: global\nconfidence: 0\.7\nusefulness: 0\ndecay: 0\nstatus: active\ncreatedAt: \S+\nupdatedAt: \S+\nwhy: "bundles break: sqlite is a builtin"\ntags:\n {2}- build\n---\n\nesbuild must mark node:sqlite external\n$/,
  );
  assert.equal((await ok(s, "stats")).facts, 1);
});

test("recall and search take the query as one bare argument, the same as --query", async () => {
  const s = store();
  await ok(s, ...GOTCHA, "the topaz build caches its output");
  assert.deepEqual(
    await ok(s, "recall", "topaz build"),
    await ok(s, "recall", "--query", "topaz build"),
  );
  assert.deepEqual(
    await ok(s, "recall", "--limit", "1", "topaz build"),
    await ok(s, "recall", "topaz build", "--limit", "1"),
  );
  const found = await ok(s, "search", "topaz");
  assert.equal(found.results.length, 1);
  assert.deepEqual(found, await ok(s, "search", "--query", "topaz"));
});

test("a bare query together with --query, or more than one bare argument, is a usage error", async () => {
  const s = store();
  for (const verb of ["recall", "search"]) {
    const twice = await mem(s, verb, "topaz", "--query", "build");
    assert.equal(twice.exit, 2, verb);
    assert.match(twice.out, /the query was given twice/, verb);
    const many = await mem(s, verb, "topaz", "build");
    assert.equal(many.exit, 2, verb);
    assert.match(many.out, /takes one query, got 2 arguments/, verb);
    assert.match(many.out, new RegExp(`→ (agentry )?mem ${verb} --help$`), verb);
  }
});

test("recall and search help name the positional query", async () => {
  const s = store();
  for (const verb of ["recall", "search"]) {
    const help = await mem(s, verb, "--help");
    assert.equal(help.exit, 0, verb);
    assert.match(help.out, /<query>/, verb);
  }
});
