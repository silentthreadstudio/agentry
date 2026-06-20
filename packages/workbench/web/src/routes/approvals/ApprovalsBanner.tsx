// ApprovalsBanner — the human side of the permission relay (Phase 3b; channels.md §"Relay permission
// prompts"). A GLOBAL, prominent overlay that appears ANYWHERE in the app when the agent has relayed a
// tool-approval prompt and is BLOCKED waiting on a verdict. It mounts once at the app shell (both the
// bare-host and run-host trees) and floats over whatever route is showing — the prompt is time-sensitive,
// so it must not be hidden behind a tab.
//
// ── Behavior ──────────────────────────────────────────────────────────────────────────────────────────
//   • Seeds from `GET /api/permissions` (requests already pending when the page loads — the agent may
//     have been blocked before the tab opened), then folds the live ws stream (`permission-added` /
//     `permission-removed`) via the pure `permissions-store` reducer. No polling.
//   • Each pending request shows: the tool name (emphasized), the description, a truncated mono
//     input_preview, and Allow / Deny. Multiple pending → stacked, oldest first.
//   • Allow/Deny POST the verdict, then the row goes "sending" (buttons disabled) until the ws
//     `permission-removed` (the request-file unlink) clears it — the SAME event that clears it when the
//     terminal answered first. So a row never lingers after it's resolved, by us or the terminal.
//   • Permissions are project-global (no run), so this subscribes to the one shared ws client on every
//     host; the server broadcasts these messages to all sockets.
import { useCallback, useEffect, useState } from "react";
import type { PermissionRequest } from "@agentry/workbench-shared";
import { fetchPermissions, postVerdict } from "../../api/index.js";
import { getWsClient } from "../../api/ws.js";
import { applyPermissionMessage, mergeSnapshot } from "./permissions-store.js";
import { useApprovalsStyles } from "./approvals-styles.js";

export function ApprovalsBanner() {
  useApprovalsStyles();
  const [pending, setPending] = useState<PermissionRequest[]>([]);
  // The ids the user has answered and is awaiting the server's `removed` confirmation on — drives the
  // per-row "sending" disabled state so a double-click can't double-POST.
  const [sending, setSending] = useState<Set<string>>(new Set());

  // Seed the snapshot once. A missing server / bare boot just yields an empty banner (no crash).
  useEffect(() => {
    const ctrl = new AbortController();
    fetchPermissions(ctrl.signal)
      .then((snap) => setPending(mergeSnapshot(snap)))
      .catch(() => {
        /* no server yet, or none pending — the banner stays hidden */
      });
    return () => ctrl.abort();
  }, []);

  // Fold the live ws stream into the pending list. Shares the one app-wide ws client.
  useEffect(() => {
    const unsubscribe = getWsClient().subscribe((msg) => {
      setPending((prev) => applyPermissionMessage(prev, msg));
      // A resolved request clears its "sending" flag (it's gone from the list anyway).
      if (msg.type === "permission-removed") {
        setSending((prev) => {
          if (!prev.has(msg.requestId)) return prev;
          const next = new Set(prev);
          next.delete(msg.requestId);
          return next;
        });
      }
    });
    return unsubscribe;
  }, []);

  const answer = useCallback((requestId: string, behavior: "allow" | "deny") => {
    setSending((prev) => new Set(prev).add(requestId));
    postVerdict(requestId, behavior).catch(() => {
      // The write failed (e.g. a poisoned id, or the server is down) — un-disable so the user can retry.
      setSending((prev) => {
        const next = new Set(prev);
        next.delete(requestId);
        return next;
      });
    });
  }, []);

  if (pending.length === 0) return null;

  return (
    <div className="apv-wrap" role="region" aria-label="Permission approvals">
      {pending.map((req) => (
        <ApprovalCard
          key={req.request_id}
          request={req}
          sending={sending.has(req.request_id)}
          onAnswer={answer}
        />
      ))}
    </div>
  );
}

function ApprovalCard({
  request,
  sending,
  onAnswer,
}: {
  request: PermissionRequest;
  sending: boolean;
  onAnswer: (requestId: string, behavior: "allow" | "deny") => void;
}) {
  return (
    <div className="apv-card" role="alertdialog" aria-label={`Approve ${request.tool_name}`}>
      <div className="apv-head">
        <span className="apv-spark" aria-hidden="true" />
        <span className="apv-lead">Claude wants to run</span>
        <span className="apv-tool">{request.tool_name}</span>
      </div>
      {request.description && <p className="apv-desc">{request.description}</p>}
      {request.input_preview && (
        <pre className="apv-prev" title={request.input_preview}>
          {request.input_preview}
        </pre>
      )}
      <div className="apv-actions">
        <button
          type="button"
          className="apv-btn apv-deny"
          disabled={sending}
          onClick={() => onAnswer(request.request_id, "deny")}
        >
          Deny
        </button>
        <button
          type="button"
          className="apv-btn apv-allow"
          disabled={sending}
          onClick={() => onAnswer(request.request_id, "allow")}
        >
          {sending ? "Sending…" : "Allow"}
        </button>
      </div>
    </div>
  );
}
