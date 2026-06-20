// permission-writer — write a verdict file for one approval request (Phase 3b, the WRITE half the
// `POST /api/permissions/:id` handler calls). The verdict file is FLOW's pinned shape:
//
//   <projectRoot>/.agentry/run/permissions/<request_id>.verdict.json  =  { request_id, behavior }
//
// FLOW's relay watches the dir for `*.verdict.json`, emits the verdict to Claude Code if the id is
// pending, then deletes both files. We only write — never read the verdict back.
//
// The `request_id` becomes a filename, so it is guarded by FLOW's `assertSafeSegment` (the SAME
// traversal guard FLOW uses, ADR-002 — reuse, don't reinvent): a poisoned id (`../escape`, `a/b`) can
// never write outside the permissions dir. The behavior is validated by the caller (the route); this
// adapter trusts the typed `behavior` it's handed.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertSafeSegment } from "@agentry/flow/domain/ids";
import { permissionsDir } from "@agentry/flow/channel/permission-relay";

export type PermissionBehavior = "allow" | "deny";

// Write `<request_id>.verdict.json`. Throws (via `assertSafeSegment`) on a traversal-unsafe id — the
// route maps that to a 400 rather than writing outside the dir.
export function writeVerdict(
  projectRoot: string,
  requestId: string,
  behavior: PermissionBehavior,
): void {
  assertSafeSegment(requestId); // a poisoned id can never become a path outside the permissions dir
  const dir = permissionsDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const record = { request_id: requestId, behavior };
  writeFileSync(join(dir, `${requestId}.verdict.json`), JSON.stringify(record, null, 2));
}
