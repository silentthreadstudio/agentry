// git-repo — a throwaway git repository for tests of the git-touching lane primitives. The developer's own
// git config (hooks, signing, templates) must not leak into the fixture, so every git call runs with a
// scrubbed environment. Not a test file: imported by worktree/gate/ledger tests.
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

/** Run git in `dir`; throws with git's stderr on a non-zero exit. Returns trimmed stdout. */
export function git(dir, ...args) {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitEnv });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

/** Write `text` to `file` (creating directories) in `dir` and commit it. Returns the commit SHA. */
export function commitFile(dir, file, text, subject = `add ${file}`) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", subject);
  return git(dir, "rev-parse", "HEAD");
}

/** A new repo on branch `main` with one commit. `cleanup()` removes it. */
export function tempRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lane-repo-")));
  git(dir, "init", "-q", "-b", "main");
  commitFile(dir, "README.md", "fixture\n", "init");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
