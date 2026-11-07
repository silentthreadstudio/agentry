// `agentry init --host opencode`: the payload, the vendored CLI and the AGENTS.md trigger block, on a
// scratch client in the shape a real one has (git root, board, process and workflow files). Preview
// writes nothing; --apply writes, and a second --apply finds zero drift.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..", "..");
const REPO = dirname(PLUGIN);
const BIN = join(PLUGIN, "bin", "agentry");
const FIXTURE = join(HERE, "fixtures", "table-board");

const run = (root, ...args) =>
  spawnSync(process.execPath, [BIN, "init", ...args, "--root", root], { encoding: "utf8" });

// A scratch client in the shape the verb serves: a git root with the board's files, the process file
// and its workflow sibling in .agentry/, the table board behind it.
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "agentry-init-"));
  spawnSync("git", ["-C", root, "init", "-q"]);
  mkdirSync(join(root, ".agentry"), { recursive: true });
  cpSync(join(FIXTURE, "process.json"), join(root, ".agentry", "process.json"));
  cpSync(join(FIXTURE, "workflow.json"), join(root, ".agentry", "workflow.json"));
  cpSync(join(FIXTURE, "docs"), join(root, "docs"), { recursive: true });
  return root;
}

// Every file under `root`, relative and sorted — the tree a write must leave untouched in preview.
function tree(root) {
  const out = [];
  const walk = (base) => {
    for (const e of readdirSync(join(root, base), { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  walk("");
  return out;
}

const withTemp = (body) => {
  const root = scratch();
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("an unknown host exits 2 with one line that names the next command", () =>
  withTemp((root) => {
    const res = run(root, "--host", "claude");
    assert.equal(res.status, 2);
    assert.equal(res.stderr, '✗ init: host "claude" unknown → init --host opencode\n');
    assert.equal(res.stdout, "");
  }));

test("--help prints the group's help and exits 0", () => {
  const res = spawnSync(process.execPath, [BIN, "init", "--help"], { encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^usage: agentry init --host opencode/);
});

test("preview writes nothing and says what one --apply would", () =>
  withTemp((root) => {
    const before = tree(root);
    const res = run(root);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /payload: \d+ changes \(would write\) \(\d+ kept\) → \.opencode\//);
    assert.match(res.stdout, /new \.opencode\/agents\/agentry\/conductor\.md/);
    assert.match(res.stdout, /trigger block:/);
    assert.match(res.stdout, /AGENTS\.md: create it with the Agentry block/);
    assert.match(res.stdout, /preview: nothing written; add --apply to write it/);
    assert.doesNotMatch(res.stdout, /vendor:/);
    assert.deepEqual(tree(root), before);
    const asJson = JSON.parse(run(root, "--json").stdout);
    assert.equal(asJson.preview, true);
    assert.equal(asJson.applied, undefined, "preview: the state carries no write record");
    assert.ok(asJson.payload.changes.length > 0);
    assert.deepEqual(tree(root), before);
  }));

test("--apply writes the payload, the jsonc, the trigger block, and the vendored CLI runs from its new home", () =>
  withTemp((root) => {
    const res = run(root, "--vendor", "--apply", "--json");
    assert.equal(res.status, 0, res.stdout);
    const state = JSON.parse(res.stdout);
    assert.equal(state.preview, false);
    // the payload: agents, commands, skills, and the jsonc the host reads
    const jsonc = JSON.parse(readFileSync(join(root, ".opencode", "opencode.jsonc"), "utf8"));
    assert.equal(jsonc.default_agent, "agentry/conductor");
    assert.deepEqual(jsonc.permissions, [
      { action: "external_directory", resource: "*", effect: "ask" },
    ]);
    assert.match(
      readFileSync(join(root, ".opencode", "agents", "agentry", "conductor.md"), "utf8"),
      /mode: primary/,
    );
    // the trigger block, in AGENTS.md
    assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /agentry:begin v1/);
    assert.deepEqual(state.trigger.files.includes("AGENTS.md"), true);
    // the vendored copy: stamped, executable, and its own --version
    const stamp = readFileSync(join(root, ".agentry", "bin", ".agentry-version"), "utf8");
    assert.match(stamp, /^[\w.+-]+\n$/, "one version line");
    assert.ok(
      statSync(join(root, ".agentry", "bin", "agentry")).mode & 0o111,
      "the bin is executable",
    );
    const vendored = spawnSync(
      process.execPath,
      [join(root, ".agentry", "bin", "agentry"), "--version"],
      {
        encoding: "utf8",
      },
    );
    assert.deepEqual([vendored.status, vendored.stdout], [0, `${stamp.trim()}\n`]);
    assert.deepEqual(state.vendored.drift, true);
    assert.deepEqual(state.check, { exit: 0, ok: true });
    // the block template came with the copy, so the vendored CLI can read its lanes back
    assert.ok(
      existsSync(join(root, ".agentry", "skills", "process", "templates", "agents-block.md")),
    );
    const explain = spawnSync(
      process.execPath,
      [
        join(root, ".agentry", "bin", "agentry"),
        "board",
        "explain",
        "--root",
        root,
        "--process",
        join(root, ".agentry", "process.json"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(explain.status, 0, explain.stderr);
    assert.match(explain.stdout, /AGENTS\.md block is current/);
  }));

test("the vendored copy leaves test files, node_modules and .docs out, and keeps the lib", () =>
  withTemp((root) => {
    assert.equal(run(root, "--vendor", "--apply", "--json").status, 0);
    const files = tree(join(root, ".agentry"));
    assert.ok(
      files.some((f) => f.startsWith("scripts/lib/")),
      "the lib copied",
    );
    assert.equal(
      files.some((f) => f.startsWith("scripts/test/")),
      false,
      "no test directory",
    );
    for (const f of files)
      if (/(^|\/)(\.docs|node_modules|test|tests)(\/|$)/.test(f) || f.includes(".test"))
        assert.fail(`copied what never copies: ${f}`);
    assert.ok(existsSync(join(root, ".agentry", "scripts", "board.mjs")));
  }));

test("a second --apply reports zero drift", () =>
  withTemp((root) => {
    assert.equal(run(root, "--vendor", "--apply").status, 0);
    const before = tree(root);
    const res = run(root, "--vendor", "--apply");
    assert.equal(res.status, 0, res.stdout);
    assert.match(res.stdout, /payload: in sync \(\d+ kept\) → \.opencode\//);
    assert.match(res.stdout, /vendor: in sync \(stamp [\w.+-]+\)/);
    assert.match(res.stdout, /AGENTS\.md: the Agentry block is up to date/);
    assert.doesNotMatch(res.stdout, /^ {6}(new|rewrite) \./m);
    assert.deepEqual(tree(root), before);
  }));

test("without --vendor the generated fallback calls plugin/bin/agentry; with it, the vendored copy", () =>
  withTemp((root) => {
    assert.ok(run(root, "--apply").stdout.length > 0);
    const none = [];
    const walk = (base) => {
      for (const e of readdirSync(join(root, ".opencode", base), { withFileTypes: true })) {
        const rel = `${base}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else none.push([rel, readFileSync(join(root, ".opencode", rel), "utf8")]);
      }
    };
    walk("");
    const fallbacks = none.filter(([, text]) => text.includes("bin/agentry"));
    assert.ok(fallbacks.length > 0, "the fallback line generated");
    for (const [file, text] of fallbacks) {
      assert.match(text, /node "plugin\/bin\/agentry"/, file);
      assert.doesNotMatch(text, /\.agentry\/bin\/agentry/, file);
    }
    rmSync(join(root, ".opencode"), { recursive: true, force: true });
    assert.ok(run(root, "--vendor", "--apply").stdout.length > 0);
    const vendoredFiles = [];
    const walk2 = (base) => {
      for (const e of readdirSync(join(root, ".opencode", base), { withFileTypes: true })) {
        const rel = `${base}/${e.name}`;
        if (e.isDirectory()) walk2(rel);
        else vendoredFiles.push(readFileSync(join(root, ".opencode", rel), "utf8"));
      }
    };
    walk2("");
    const calls = vendoredFiles.filter((t) => t.includes("bin/agentry"));
    assert.ok(calls.length > 0, "the fallback line generated again");
    for (const copy of calls) assert.match(copy, /node "\.agentry\/bin\/agentry"/);
    for (const copy of calls) assert.doesNotMatch(copy, /node "plugin\/bin\/agentry"/);
  }));

test("--apply in a fresh repo with no process file skips the trigger block, keeps the rest and exits 0", () => {
  const root = mkdtempSync(join(tmpdir(), "agentry-init-fresh-"));
  try {
    spawnSync("git", ["-C", root, "init", "-q"]);
    const res = run(root, "--host", "opencode", "--vendor", "--apply");
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.ok(existsSync(join(root, ".opencode", "agents", "agentry")), "payload written");
    assert.ok(existsSync(join(root, ".agentry", "bin", "agentry")), "vendored CLI written");
    assert.doesNotMatch(
      readFileSync(join(root, "AGENTS.md"), "utf8"),
      /^## Agentry$/m,
      "no trigger block",
    );
    assert.match(res.stdout, /run \/agentry\/init in OpenCode to learn your board/);
    assert.doesNotMatch(res.stdout + res.stderr, /\/agentry:init/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --global: the payload in OpenCode's global config dir, found from XDG_CONFIG_HOME so the test never
// reads the real one. No repo is touched.
const runGlobal = (xdg, ...args) =>
  spawnSync(process.execPath, [BIN, "init", "--host", "opencode", "--global", ...args], {
    encoding: "utf8",
    cwd: xdg,
    env: { ...process.env, XDG_CONFIG_HOME: xdg },
  });

test("--global --apply writes agents, commands and skills to $XDG_CONFIG_HOME/opencode, touches no repo, and a second run is in sync", () => {
  const xdg = mkdtempSync(join(tmpdir(), "agentry-init-xdg-"));
  const repo = scratch();
  try {
    const repoBefore = tree(repo);
    const preview = runGlobal(xdg);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /payload: \d+ changes \(would write\)/);
    assert.deepEqual(tree(xdg), [], "preview writes nothing");
    const res = runGlobal(xdg, "--apply", "--root", repo);
    assert.equal(res.status, 0, res.stderr);
    const dir = join(xdg, "opencode");
    assert.ok(existsSync(join(dir, "agents", "agentry", "conductor.md")));
    assert.ok(readdirSync(join(dir, "commands", "agentry")).length > 0);
    assert.ok(readdirSync(join(dir, "skills")).length > 0);
    assert.ok(!existsSync(join(dir, "opencode.jsonc")), "the repo config is not a global file");
    assert.ok(!existsSync(join(dir, "AGENTS.md")));
    assert.deepEqual(tree(repo), repoBefore, "no repo file written");
    const text = readFileSync(join(dir, "agents", "agentry", "conductor.md"), "utf8");
    assert.match(text, /`agentry`, the global bin/);
    assert.doesNotMatch(text, /plugin\/bin\/agentry|\.agentry\/bin/);
    const again = runGlobal(xdg, "--apply");
    assert.equal(again.status, 0);
    assert.match(again.stdout, /payload: in sync \(\d+ kept\)/);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--global --vendor is a usage error (exit 2)", () => {
  const xdg = mkdtempSync(join(tmpdir(), "agentry-init-xdg-"));
  try {
    const res = runGlobal(xdg, "--vendor", "--apply");
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--global and --vendor do not go together/);
    assert.deepEqual(tree(xdg), []);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test("--global keeps the user's own files in the global dir and rewrites a changed generated one", () => {
  const xdg = mkdtempSync(join(tmpdir(), "agentry-init-xdg-"));
  try {
    const dir = join(xdg, "opencode");
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "agents", "mine.md"), "mine\n");
    writeFileSync(join(dir, "opencode.jsonc"), "{}\n");
    assert.equal(runGlobal(xdg, "--apply").status, 0);
    assert.equal(readFileSync(join(dir, "agents", "mine.md"), "utf8"), "mine\n");
    assert.equal(readFileSync(join(dir, "opencode.jsonc"), "utf8"), "{}\n");
    const mine = join(dir, "agents", "agentry", "conductor.md");
    writeFileSync(mine, "edited\n");
    const res = runGlobal(xdg, "--apply");
    assert.match(res.stdout, /rewrite agents\/agentry\/conductor\.md/);
    assert.notEqual(readFileSync(mine, "utf8"), "edited\n");
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test("repo-mode init from a vendored source without --vendor names the global agentry bin, not plugin/bin/agentry", () =>
  withTemp((root) => {
    // a vendored package's shape: the plugin payload with its generator inside it
    // realpath: the generator only runs as a script when its path is not behind a symlink (/var on macOS)
    const pkg = realpathSync(mkdtempSync(join(tmpdir(), "agentry-init-pkg-")));
    try {
      cpSync(PLUGIN, join(pkg, "vendor"), { recursive: true });
      mkdirSync(join(pkg, "vendor", "scripts"), { recursive: true });
      cpSync(
        join(REPO, "scripts", "build-opencode.mjs"),
        join(pkg, "vendor", "scripts", "build-opencode.mjs"),
      );
      const res = run(root, "--src", join(pkg, "vendor"), "--apply");
      assert.equal(res.status, 0, res.stderr);
      const text = readFileSync(
        join(root, ".opencode", "agents", "agentry", "conductor.md"),
        "utf8",
      );
      assert.match(text, /`agentry`, the global bin/);
      for (const rel of tree(join(root, ".opencode")))
        assert.doesNotMatch(
          readFileSync(join(root, ".opencode", rel), "utf8"),
          /plugin\/bin\/agentry/,
          rel,
        );
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
  }));
