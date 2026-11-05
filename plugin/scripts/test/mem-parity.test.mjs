// Parity with the MCP server this port replaces: a store written by the bundle (plugin/mem/index.js, driven over
// MCP stdio) reads the same through the new code, and a store written through `agentry mem` reads the same
// through the bundle. "The same" is: stats, recall, search and the files' bytes. Skipped when the bundle is
// absent (it is retired by the switch-over lane).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import { resolveRoots } from "../lib/memory/resolution/roots.mjs";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(SCRIPTS, "..", "mem", "index.js");
const skip = existsSync(BUNDLE) ? false : "plugin/mem/index.js is absent";
const CLI = join(SCRIPTS, "lib", "memory", "cli");

/** A minimal MCP client over the bundle's stdio: `call(tool, args) -> the tool's JSON payload`. */
function bundle(env) {
  const child = spawn(process.execPath, [BUNDLE], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let buffered = "";
  let id = 0;
  const waiting = new Map();
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    for (let i = buffered.indexOf("\n"); i >= 0; i = buffered.indexOf("\n")) {
      const line = buffered.slice(0, i);
      buffered = buffered.slice(i + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  const send = (method, params) =>
    new Promise((resolve) => {
      id += 1;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return {
    async start() {
      await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mem-parity", version: "0" },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
    },
    async call(name, args = {}) {
      const reply = await send("tools/call", { name, arguments: args });
      assert.ok(!reply.result?.isError, `${name}: ${JSON.stringify(reply)}`);
      return JSON.parse(reply.result.content[0].text);
    },
    stop: () => child.kill(),
  };
}

/** Fresh roots, the bundle running over them, and the new code over the same roots. */
async function setup() {
  const roots = {
    AGENTRY_GLOBAL_DIR: mkdtempSync(join(tmpdir(), "agentry-parity-g-")),
    CLAUDE_PROJECT_DIR: mkdtempSync(join(tmpdir(), "agentry-parity-p-")),
  };
  const mcp = bundle(roots);
  await mcp.start();
  return {
    roots,
    mcp,
    /** The new code's view of the store, loaded now. */
    service() {
      const r = resolveRoots(roots);
      const service = new MemoryService(new MarkdownFileStore(r), new SqliteTextIndex(), r);
      service.load();
      return service;
    },
    /** `mem <argv> --json` through the router, with the roots in the environment. */
    async mem(...argv) {
      const saved = Object.fromEntries(Object.keys(roots).map((k) => [k, process.env[k]]));
      Object.assign(process.env, roots);
      try {
        const r = await route([...argv, "--json"], { dir: CLI, name: "mem" });
        assert.equal(r.exit, 0, r.out);
        return JSON.parse(r.out);
      } finally {
        for (const [k, v] of Object.entries(saved))
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
      }
    },
  };
}

const json = (value) => JSON.parse(JSON.stringify(value));
const QUERIES = [
  "topaz cache",
  "colons hashes quotes",
  "evolution subject",
  "opal index",
  "garnet lookup café",
  "zircon gauge",
  "decide",
  "episode",
];

/** The new code and the bundle answer stats, recall, search and prime the same. */
async function assertSame({ service, mcp }) {
  const view = service();
  assert.equal(view.stats().readErrors.length, 0);
  assert.deepEqual(json(view.stats()), await mcp.call("memory_stats"));
  for (const query of QUERIES) {
    assert.deepEqual(
      json(view.recall({ query, limit: 5 })),
      await mcp.call("memory_recall", { query, limit: 5 }),
      `recall ${query}`,
    );
    assert.deepEqual(
      { results: view.search(query, 10) },
      await mcp.call("memory_search", { query }),
      `search ${query}`,
    );
  }
  assert.deepEqual(
    json(view.recall({ mode: "prime", limit: 3 })),
    await mcp.call("memory_recall", { mode: "prime", limit: 3 }),
  );
}

// A record file's frontmatter as its top-level blocks (a key and its continuation lines), in any order.
const blocks = (file) => {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(file, "utf8"))[1];
  return front.split(/\n(?=\S)/).sort();
};

/** Every record file under `root`, by name. */
const filesOf = (root) =>
  Object.fromEntries(
    ["facts", "episodes"].flatMap((kind) =>
      existsSync(join(root, kind))
        ? readdirSync(join(root, kind)).map((f) => [`${kind}/${f}`, join(root, kind, f)])
        : [],
    ),
  );

const LONG =
  "a long line that the yaml writer folds at eighty columns, with several words to fold on ".repeat(
    3,
  );
const EDGE = [
  { type: "gotcha", scope: "global", text: "plain fact about the topaz build cache" },
  {
    type: "decision",
    scope: "repo",
    text: "decide: colons, #hashes and 'quotes' in text",
    why: "why: \"double\" and 'single' quotes, a # hash, and a: colon",
    tags: ["a: b", "true", "123", "it's"],
  },
  {
    type: "learning",
    scope: "repo",
    text: "evolution fact with a subject",
    subject: "conducting",
    why: LONG,
    tags: ["evolution"],
  },
  {
    type: "preference",
    scope: "global",
    text: "multi-line why for the opal index",
    why: "first line\nsecond line\n\nthird after a blank",
  },
  {
    type: "repo-fact",
    scope: "global",
    text: "unicode café ✓ naïve 日本語 in the garnet lookup",
    why: " leading space and trailing space ",
    tags: ["日本語"],
  },
  {
    type: "gap",
    scope: "repo",
    text: "a gap with provenance in the zircon gauge",
    provenance: ["p:01EPISODE", "packages/memory/src/x.ts"],
    repoId: "agentry",
  },
];
const EPISODES = [
  {
    task: "port the store in one episode",
    shape: "decompose+verify",
    outcome: "pass: 78 tests",
    retries: 1,
    lesson: LONG,
  },
  { task: "another episode run", shape: "one-shot", outcome: "fail" },
];

test(
  "a store written by the MCP bundle reads the same through the new code",
  { skip },
  async () => {
    const t = await setup();
    try {
      const ids = [];
      for (const input of EDGE) ids.push((await t.mcp.call("memory_write", input)).id);
      await t.mcp.call("memory_write", {
        ...EDGE[1],
        supersedes: ids[0],
        text: "decide anew: the topaz cache moved",
      });
      await t.mcp.call("memory_feedback", {
        recalled: [ids[1], ids[3]],
        used: [ids[1]],
        outcome: "pass",
      });
      for (let strike = 0; strike < 4; strike++)
        await t.mcp.call("memory_feedback", { recalled: [ids[5]], used: [], outcome: "pass" });
      for (const episode of EPISODES)
        await t.mcp.call("episode_write", { ...episode, usedMemories: [ids[1]] });

      await assertSame(t);

      // and every file it wrote is one the new writer writes back, key for key
      const copy = mkdtempSync(join(tmpdir(), "agentry-parity-copy-"));
      const r = resolveRoots(t.roots);
      const store = new MarkdownFileStore(r);
      const copyStore = new MarkdownFileStore({ global: copy, project: null });
      for (const { fact } of store.readFacts().records) copyStore.writeFact("g", fact);
      for (const { episode } of store.readEpisodes().records) copyStore.writeEpisode("g", episode);
      const [theirs, mine] = [{ ...filesOf(r.global), ...filesOf(r.project) }, filesOf(copy)];
      assert.deepEqual(Object.keys(mine).sort(), Object.keys(theirs).sort());
      for (const name of Object.keys(theirs))
        assert.deepEqual(blocks(mine[name]), blocks(theirs[name]), name);
    } finally {
      t.mcp.stop();
    }
  },
);

test(
  "a store written through agentry mem reads the same through the MCP bundle",
  { skip },
  async () => {
    const t = await setup();
    try {
      const flags = (input) =>
        Object.entries(input).flatMap(([k, v]) =>
          [v]
            .flat()
            .flatMap((item) => [`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}=${item}`]),
        );
      const ids = [];
      for (const input of EDGE) ids.push((await t.mem("write", ...flags(input))).id);
      await t.mem(
        "write",
        ...flags({ ...EDGE[1], supersedes: ids[0], text: "decide anew: the topaz cache moved" }),
      );
      await t.mem(
        "feedback",
        "--recalled",
        ids[1],
        "--recalled",
        ids[3],
        "--used",
        ids[1],
        "--outcome",
        "pass",
      );
      for (let strike = 0; strike < 4; strike++)
        await t.mem("feedback", "--recalled", ids[5], "--outcome", "pass");
      for (const episode of EPISODES)
        await t.mem("episode", ...flags({ ...episode, usedMemories: ids[1] }));

      await assertSame(t);

      // the bundle can act on what the CLI wrote, and the new code reads what the bundle then wrote
      assert.deepEqual(await t.mcp.call("memory_recover", { id: ids[5] }), { recovered: true });
      assert.deepEqual(
        await t.mcp.call("memory_update", {
          id: ids[2],
          confidence: 0.9,
          tags: ["evolution", "edited"],
        }),
        { id: ids[2], updated: true },
      );
      await assertSame(t);
      const { memories } = await t.mem("recall", "--query", "evolution subject");
      assert.deepEqual(memories[0].fact.tags, ["evolution", "edited"]);
      assert.equal(memories[0].fact.confidence, 0.9);
    } finally {
      t.mcp.stop();
    }
  },
);

test(
  "values that end in newlines, on the last frontmatter key, read the same as the bundle reads them",
  { skip },
  async () => {
    // memory_write puts `subject` last, episode_write puts `lesson` last when no memory was used: both end the
    // frontmatter, where a |+ scalar's trailing newlines are the file's last lines
    const t = await setup();
    try {
      await t.mcp.call("memory_write", {
        type: "learning",
        scope: "repo",
        text: "keep chomp probe fact",
        subject: "the subject\n\n",
      });
      await t.mcp.call("episode_write", {
        task: "keep chomp probe episode",
        shape: "one-shot",
        outcome: "pass",
        lesson: "the lesson\n\n",
      });

      const view = t.service();
      assert.deepEqual(
        json(view.recall({ query: "keep chomp probe" })),
        await t.mcp.call("memory_recall", { query: "keep chomp probe" }),
      );
      assert.deepEqual(
        json(view.recall({ mode: "prime" })),
        await t.mcp.call("memory_recall", { mode: "prime" }),
      );
      assert.equal(
        view.recall({ query: "keep chomp probe" }).memories[0].fact.subject,
        "the subject\n",
      );
      assert.equal(view.recall({ mode: "prime" }).episodes[0].lesson, "the lesson\n");
    } finally {
      t.mcp.stop();
    }
  },
);

test("hand-edited fact files read as the bundle reads them", { skip }, async () => {
  const t = await setup();
  try {
    const dir = join(t.roots.CLAUDE_PROJECT_DIR, ".agentry", "memory", "facts");
    mkdirSync(dir, { recursive: true });
    const base = (id) =>
      `id: p:${id}\ntype: gotcha\nscope: repo\nconfidence: 0.7\nusefulness: 0\ndecay: 0\nstatus: active\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n`;
    const cases = {
      "01HE0000000000000000000001": (b) => `${b}meta:\n  source: hand\n`,
      "01HE0000000000000000000002": (b) => b.replace("type: gotcha", '"type": gotcha'),
      "01HE0000000000000000000003": (b) => `${b}my note: added by hand\n`,
      "01HE0000000000000000000004": (b) => `${b}extra: {a: 1}\n`,
    };
    for (const [id, edit] of Object.entries(cases))
      writeFileSync(join(dir, `hand-${id}.md`), `---\n${edit(base(id))}---\n\nhand edit ${id}\n`);

    const view = t.service();
    const mine = view.stats();
    assert.equal(mine.facts, 4);
    assert.deepEqual(mine.readErrors, []);
    assert.deepEqual(json(mine), await t.mcp.call("memory_stats"));
    assert.deepEqual(
      json(view.recall({ query: "hand edit", limit: 10 })),
      await t.mcp.call("memory_recall", { query: "hand edit", limit: 10 }),
    );
    assert.deepEqual(await t.mem("stats"), json(mine));
  } finally {
    t.mcp.stop();
  }
});

test(
  "update --tags-clear writes tags: [] as the bundle's memory_update does",
  { skip },
  async () => {
    const t = await setup();
    try {
      const { id } = await t.mem(
        "write",
        "--type",
        "gotcha",
        "--scope",
        "global",
        "--text",
        "a tagged fact for clearing",
        "--tags",
        "a",
        "--tags",
        "b",
      );
      await t.mem("update", "--id", id, "--tags-clear");
      const [file] = readdirSync(join(t.roots.AGENTRY_GLOBAL_DIR, ".agentry", "memory", "facts"));
      const written = readFileSync(
        join(t.roots.AGENTRY_GLOBAL_DIR, ".agentry", "memory", "facts", file),
        "utf8",
      );
      assert.match(written, /^tags: \[\]$/m);

      // the bundle writes the same line, and reads what the CLI wrote
      await t.mcp.call("memory_stats"); // the bundle sees another process's write on a read
      await t.mcp.call("memory_update", { id, tags: [] });
      assert.equal(
        readFileSync(
          join(t.roots.AGENTRY_GLOBAL_DIR, ".agentry", "memory", "facts", file),
          "utf8",
        ).match(/^tags: \[\]$/m)?.[0],
        "tags: []",
      );
      assert.deepEqual(
        json(t.service().recall({ query: "tagged fact clearing" })),
        await t.mcp.call("memory_recall", { query: "tagged fact clearing" }),
      );
    } finally {
      t.mcp.stop();
    }
  },
);

test(
  "an apostrophe in an unknown flow mapping neither drops the next key nor refuses the file",
  { skip },
  async () => {
    const t = await setup();
    try {
      const dir = join(t.roots.CLAUDE_PROJECT_DIR, ".agentry", "memory", "facts");
      mkdirSync(dir, { recursive: true });
      const base = (id) =>
        `id: p:${id}\ntype: gotcha\nscope: repo\nconfidence: 0.7\nusefulness: 0\ndecay: 0\nstatus: active\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n`;
      const edits = [
        "meta: {note: it's mine}\nwhy: don't drop me}\n",
        "meta: {note: it's}\nwhy: second\n",
        "meta: {author: O'Brien}\nwhy: third\n",
      ];
      edits.forEach((edit, i) => {
        const id = `01SW000000000000000000000${i}`;
        writeFileSync(
          join(dir, `swallow-probe-${id}.md`),
          `---\n${base(id)}${edit}---\n\nswallow probe fact\n`,
        );
      });

      const view = t.service();
      assert.deepEqual(view.stats().readErrors, []);
      const theirs = await t.mcp.call("memory_recall", { query: "swallow probe", limit: 10 });
      assert.deepEqual(json(view.recall({ query: "swallow probe", limit: 10 })), theirs);
      assert.deepEqual(theirs.memories.map((m) => m.fact.why).sort(), [
        "don't drop me}",
        "second",
        "third",
      ]);
      assert.deepEqual(
        json(await t.mem("recall", "--query", "swallow probe", "--limit", "10")),
        theirs,
      );
    } finally {
      t.mcp.stop();
    }
  },
);
