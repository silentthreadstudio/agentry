// doc-io — the doc-editor's transport layer: the three doc-scoped endpoints the editor calls plus the
// loose-frontmatter reader. Co-located with DocEditor (not folded into the global api/client.ts) on
// purpose — these are editor-specific writes with editor-specific result messages, right-sized as a small
// module beside the view rather than spread into the shared client. The view (DocEditor.tsx) imports these
// and owns only orchestration + render.
import type { DocModel } from "@agentry/workbench-shared";

// GET /api/work/:id/doc/:docId → DocModel.
export async function fetchDoc(runId: string, docId: string, signal: AbortSignal): Promise<DocModel> {
  const res = await fetch(
    `/api/work/${encodeURIComponent(runId)}/doc/${encodeURIComponent(docId)}`,
    { headers: { accept: "application/json" }, signal },
  );
  if (!res.ok) {
    throw new Error(`doc ${docId} → ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as DocModel;
}

// The save POST (POST /api/work/:id/artifact { target, baseVersion, newBody }). Echoes the OPAQUE
// baseVersion it was handed (ADR-006). A 409 is the stale-version rejection.
export interface SaveResult {
  ok: boolean;
  status: number;
  message: string;
}

export async function postArtifact(
  runId: string,
  target: string,
  baseVersion: string,
  newBody: string,
): Promise<SaveResult> {
  const res = await fetch(`/api/work/${encodeURIComponent(runId)}/artifact`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ target, baseVersion, newBody }),
  });
  const message = res.ok
    ? "Saved — version bumped; the agent reads it next turn."
    : res.status === 409
      ? "Out of date — the agent wrote this since you opened it. Reopen to merge."
      : `Save failed (${res.status} ${res.statusText}).`;
  return { ok: res.ok, status: res.status, message };
}

// Set a task's FLOW status (POST /api/work/:id/status { target, status }). Returns whether it stuck; the
// caller reloads the doc on success so the header pill / lock re-derive from the new frontmatter.
export async function postStatus(runId: string, target: string, status: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/work/${encodeURIComponent(runId)}/status`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ target, status }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// FLOW frontmatter is loose (`Record<string, unknown>`); read a few known string fields defensively.
export function fmString(fm: Record<string, unknown>, key: string): string | null {
  const v = fm[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}
