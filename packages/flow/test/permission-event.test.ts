// Permission-event — the PURE shapes/validation of the permission relay (no I/O). Proves: a valid
// verdict file parses; malformed/unknown-behavior/bad-JSON yields undefined (never throws); a verdict
// for a pending id resolves to an emit and an unknown id resolves to nothing; the request file shape
// carries the four params + created_at.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRequestFile,
  parseVerdictFile,
  resolveVerdict,
  type PermissionVerdictFile,
} from "../src/channel/permission-event.js";

// ── buildRequestFile ──────────────────────────────────────────────────────────
test("buildRequestFile carries the four params + the injected created_at", () => {
  const file = buildRequestFile(
    { request_id: "abcde", tool_name: "Bash", description: "list files", input_preview: '{"cmd":"ls"}' },
    "2026-06-19T00:00:00.000Z",
  );
  assert.deepEqual(file, {
    request_id: "abcde",
    tool_name: "Bash",
    description: "list files",
    input_preview: '{"cmd":"ls"}',
    created_at: "2026-06-19T00:00:00.000Z",
  });
});

// ── parseVerdictFile ──────────────────────────────────────────────────────────
test("parseVerdictFile accepts a well-formed allow verdict", () => {
  assert.deepEqual(parseVerdictFile('{"request_id":"abcde","behavior":"allow"}'), {
    request_id: "abcde",
    behavior: "allow",
  });
});

test("parseVerdictFile accepts a well-formed deny verdict", () => {
  assert.deepEqual(parseVerdictFile('{"request_id":"abcde","behavior":"deny"}'), {
    request_id: "abcde",
    behavior: "deny",
  });
});

test("parseVerdictFile returns undefined for non-JSON (no throw)", () => {
  assert.equal(parseVerdictFile("not json {"), undefined);
});

test("parseVerdictFile returns undefined for an unknown behavior", () => {
  assert.equal(parseVerdictFile('{"request_id":"abcde","behavior":"maybe"}'), undefined);
});

test("parseVerdictFile returns undefined when request_id is missing", () => {
  assert.equal(parseVerdictFile('{"behavior":"allow"}'), undefined);
});

test("parseVerdictFile returns undefined for a non-object (e.g. a bare array)", () => {
  assert.equal(parseVerdictFile("[1,2,3]"), undefined);
});

// ── resolveVerdict ────────────────────────────────────────────────────────────
function verdict(over: Partial<PermissionVerdictFile> = {}): PermissionVerdictFile {
  return { request_id: "abcde", behavior: "allow", ...over };
}

test("resolveVerdict emits the verdict notification for a pending id", () => {
  const out = resolveVerdict(verdict({ behavior: "deny" }), new Set(["abcde"]));
  assert.deepEqual(out, {
    method: "notifications/claude/channel/permission",
    params: { request_id: "abcde", behavior: "deny" },
  });
});

test("resolveVerdict emits nothing for an unknown/stale id", () => {
  assert.equal(resolveVerdict(verdict({ request_id: "zzzzz" }), new Set(["abcde"])), undefined);
});

test("resolveVerdict emits nothing when the pending set is empty", () => {
  assert.equal(resolveVerdict(verdict(), new Set()), undefined);
});
