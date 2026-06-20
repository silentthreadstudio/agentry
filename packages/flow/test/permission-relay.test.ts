// Permission relay — the watcher + fs + emit wiring over a REAL chokidar watcher on a tmpdir. Proves:
//   - a permission_request writes `<id>.json` to the permissions dir + tracks the id pending;
//   - a verdict file for a PENDING id emits one verdict notification {request_id, behavior} and
//     deletes BOTH files;
//   - a verdict for an UNKNOWN id never emits (and clears the stray verdict file);
//   - a malformed verdict json is ignored — no emit, no throw.
// The emit is a spy. The request path is driven via `onRequest` (the registrar handler delegates
// straight to it), so no live SDK transport is needed.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { PermissionRelay, permissionsDir } from "../src/channel/permission-relay.js";
import type { PermissionVerdictNotification } from "../src/channel/permission-event.js";

// Poll until `predicate` holds or the deadline passes — chokidar's fs events are async.
async function waitFor(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Let the watcher settle its initial scan before we drop a verdict file.
async function settle(ms = 400): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function writeVerdict(cwd: string, requestId: string, body: string): void {
  writeFileSync(join(permissionsDir(cwd), `${requestId}.verdict.json`), body);
}

let cwd: string;
let relay: PermissionRelay;
let emitted: PermissionVerdictNotification[];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "flow-perm-"));
  emitted = [];
});

afterEach(async () => {
  await relay?.stop();
  rmSync(cwd, { recursive: true, force: true });
});

test("a permission_request writes the request file and tracks the id pending", () => {
  relay = new PermissionRelay(cwd, (n) => void emitted.push(n));
  relay.onRequest({ request_id: "abcde", tool_name: "Bash", description: "run ls", input_preview: '{"cmd":"ls"}' });

  assert.deepEqual(relay.pendingIds(), ["abcde"]);
  const file = JSON.parse(readFileSync(join(permissionsDir(cwd), "abcde.json"), "utf8"));
  assert.equal(file.request_id, "abcde");
  assert.equal(file.tool_name, "Bash");
  assert.equal(file.description, "run ls");
  assert.equal(file.input_preview, '{"cmd":"ls"}');
  assert.equal(typeof file.created_at, "string");
});

test("a verdict for a pending id emits the verdict and deletes both files", async () => {
  relay = new PermissionRelay(cwd, (n) => void emitted.push(n));
  relay.start();
  await settle();

  relay.onRequest({ request_id: "abcde", tool_name: "Write", description: "write a file", input_preview: "{}" });
  writeVerdict(cwd, "abcde", '{"request_id":"abcde","behavior":"allow"}');

  await waitFor(() => emitted.length >= 1);
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], {
    method: "notifications/claude/channel/permission",
    params: { request_id: "abcde", behavior: "allow" },
  });
  // pending cleared + both files deleted
  assert.deepEqual(relay.pendingIds(), []);
  await waitFor(() => !existsSync(join(permissionsDir(cwd), "abcde.json")));
  assert.ok(!existsSync(join(permissionsDir(cwd), "abcde.json")), "request file deleted");
  assert.ok(!existsSync(join(permissionsDir(cwd), "abcde.verdict.json")), "verdict file deleted");
});

test("a deny verdict emits behavior:deny", async () => {
  relay = new PermissionRelay(cwd, (n) => void emitted.push(n));
  relay.start();
  await settle();

  relay.onRequest({ request_id: "bcdef", tool_name: "Bash", description: "rm -rf", input_preview: "{}" });
  writeVerdict(cwd, "bcdef", '{"request_id":"bcdef","behavior":"deny"}');

  await waitFor(() => emitted.length >= 1);
  assert.equal(emitted[0].params.behavior, "deny");
});

test("a verdict for an UNKNOWN id never emits (stray verdict file ignored)", async () => {
  relay = new PermissionRelay(cwd, (n) => void emitted.push(n));
  relay.start();
  await settle();

  // No request issued for this id — it's not in the pending set.
  writeVerdict(cwd, "zzzzz", '{"request_id":"zzzzz","behavior":"allow"}');
  await settle(600);
  assert.equal(emitted.length, 0, "a verdict for an id flow never issued must not emit");
});

test("a malformed verdict json is ignored — no emit, no throw", async () => {
  relay = new PermissionRelay(cwd, (n) => void emitted.push(n));
  relay.start();
  await settle();

  relay.onRequest({ request_id: "cdefg", tool_name: "Bash", description: "x", input_preview: "{}" });
  writeVerdict(cwd, "cdefg", "not valid json {");
  await settle(600);

  assert.equal(emitted.length, 0, "a malformed verdict must not emit");
  // the id stays pending (the malformed file didn't resolve it), and the request file remains
  assert.deepEqual(relay.pendingIds(), ["cdefg"]);
  assert.ok(existsSync(join(permissionsDir(cwd), "cdefg.json")), "request file untouched by a bad verdict");
});
