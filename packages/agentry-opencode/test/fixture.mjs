// fixture — the offline fixtures the package's tests run against: a temp copy of a synthetic board
// from the plugin's test fixtures, laid out where a `--root` call finds it (`.agentry/process.json`
// with its sibling workflow file), and a temp git repo around a board when one is needed. Git runs
// with a scrubbed environment so a developer's hooks and signing never touch a fixture.
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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "plugin",
  "scripts",
  "test",
  "fixtures",
);

const temp = [];
export const fixtureCleanup = () => {
  for (const dir of temp) rmSync(dir, { recursive: true, force: true });
};

export const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

export function git(dir, ...args) {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitEnv });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

// A temp copy of a synthetic board where route() finds it: `<root>/.agentry/process.json` (+ the
// sibling workflow file a fixture carries). `subjects` also make it a git repo, one commit each with
// that subject, after the first commit the board itself takes.
export function mkBoard(fixture = "table-board", subjects = []) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentry-opencode-board-")));
  temp.push(root);
  cpSync(join(FIXTURES, fixture), root, { recursive: true });
  mkdirSync(join(root, ".agentry"));
  cpSync(join(root, "process.json"), join(root, ".agentry", "process.json"));
  if (existsSync(join(root, "workflow.json"))) {
    cpSync(join(root, "workflow.json"), join(root, ".agentry", "workflow.json"));
  }
  unlinkSync(join(root, "process.json"));
  if (existsSync(join(root, "workflow.json"))) unlinkSync(join(root, "workflow.json"));
  if (subjects.length) {
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    for (const [i, subject] of subjects.entries()) {
      writeFileSync(join(root, `f${i}.txt`), `${i}\n`);
      git(root, "add", `f${i}.txt`);
      git(root, "commit", "-q", "-m", subject);
    }
  }
  return root;
}

// A path→bytes map of a fixture's files, for an unchanged check on a preview: `.git` and the
// run state under `.agentry` are the session's own noise, not the board.
export function snapshot(root) {
  const files = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.name === ".git" || entry.name === ".agentry") continue;
      if (entry.isDirectory()) walk(file);
      else files[file] = readFileSync(file, "utf8");
    }
  };
  walk(root);
  return files;
}
