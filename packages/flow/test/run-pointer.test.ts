// run-pointer + resolveRunContext — the ADR-005 NO-branch identity contract: a pointer round-trips,
// resolveRunContext requires an explicit run, and it ERRORS (never scans a folder) when unresolved.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { resolveRunContext } from "../src/index.js";
import { resolveRunFromSession, runDir, workRoot, writeSessionPointer } from "../src/resolution/run-pointer.js";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "flow-pointer-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

test("resolveRunFromSession round-trips a pointer written by writeSessionPointer", () => {
  writeSessionPointer(cwd, "sess-1", "add-pagination-9f3k2a");
  assert.equal(resolveRunFromSession(cwd, "sess-1"), "add-pagination-9f3k2a");
});

test("resolveRunFromSession returns undefined when no pointer exists", () => {
  assert.equal(resolveRunFromSession(cwd, "never-bound"), undefined);
});

test("resolveRunFromSession rejects a poisoned pointer (traversal workId)", () => {
  // hand-write a pointer with a traversal workId — must NOT be returned (containment).
  const dir = join(cwd, ".agentry", "run", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "evil.json"), JSON.stringify({ workId: "../../escape", updatedAt: "t" }));
  assert.equal(resolveRunFromSession(cwd, "evil"), undefined);
});

test("resolveRunContext returns the explicit run arg (precedence 1)", () => {
  const ctx = resolveRunContext({ run: "explicit-run-1" }, { CLAUDE_PROJECT_DIR: cwd });
  assert.equal(ctx.run, "explicit-run-1");
  assert.equal(ctx.cwd, cwd);
});

test("resolveRunContext falls back to the session pointer only when session_id is passed", () => {
  writeSessionPointer(cwd, "sess-2", "run-from-pointer");
  const ctx = resolveRunContext({ session_id: "sess-2" }, { CLAUDE_PROJECT_DIR: cwd });
  assert.equal(ctx.run, "run-from-pointer");
});

test("resolveRunContext ERRORS when no run and no resolvable pointer — never scans a folder", () => {
  // Seed a newest-mtime folder under work/ — the anti-pattern would pick it. resolveRunContext must
  // ignore it entirely and throw.
  mkdirSync(runDir(cwd, "a-tempting-newest-folder"), { recursive: true });
  assert.ok(workRoot(cwd).endsWith(join(".agentry", "work")));
  assert.throws(
    () => resolveRunContext({}, { CLAUDE_PROJECT_DIR: cwd }),
    /no run resolved/,
  );
  // even with an unbound session_id, no folder scan — still errors.
  assert.throws(
    () => resolveRunContext({ session_id: "unbound" }, { CLAUDE_PROJECT_DIR: cwd }),
    /no run resolved/,
  );
});
