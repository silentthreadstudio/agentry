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
import { fetchPermissions, postVerdict } from "../api/client.js";
import { getWsClient } from "../api/ws-client.js";
import { applyPermissionMessage, mergeSnapshot } from "./permissions-store.js";

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

// ── Styles (injected once) ────────────────────────────────────────────────────────────────────────────
// The ui-v2 language: a layered-black card with the accent border-glow. The one place a touch of urgency
// is sanctioned — Allow uses the accent, Deny a restrained red (--block). Every color reads a tokens.css
// var; no new palette. Fixed bottom-right so it floats over any route without shifting layout.
function injectOnce(id: string, css: string): void {
  if (document.getElementById(id)) return;
  const el = document.createElement("style");
  el.id = id;
  el.textContent = css;
  document.head.appendChild(el);
}

const STYLE_ID = "agentry-approvals-styles";
function useApprovalsStyles(): void {
  useEffect(() => injectOnce(STYLE_ID, APPROVALS_CSS), []);
}

const APPROVALS_CSS = `
.apv-wrap{position:fixed;right:18px;bottom:18px;z-index:1000;display:flex;flex-direction:column;gap:10px;width:min(380px,calc(100vw - 36px));pointer-events:none}
.apv-card{pointer-events:auto;background:var(--panel);border:1px solid var(--accent-line);border-radius:var(--r-xl);padding:14px 14px 12px;box-shadow:0 14px 40px -12px #000c,0 0 0 1px var(--accent-soft);animation:apv-in .18s ease-out}
@keyframes apv-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){.apv-card{animation:none}}
.apv-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.apv-spark{width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.apv-lead{color:var(--muted);font-size:12px}
.apv-tool{font:700 13px var(--sans);color:var(--ink);background:var(--accent-soft);border:1px solid var(--accent-line);border-radius:var(--r-sm);padding:1px 7px}
.apv-desc{margin:9px 0 0;color:var(--ink2);font-size:12.5px;line-height:1.45;word-break:break-word}
.apv-prev{margin:9px 0 0;font:11.5px/1.4 var(--mono);color:var(--muted);background:var(--bg2);border:1px solid var(--line);border-radius:var(--r-md);padding:7px 9px;max-height:84px;overflow:auto;white-space:pre-wrap;word-break:break-all}
.apv-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.apv-btn{font:600 12.5px var(--sans);padding:6px 15px;border-radius:var(--r-md);cursor:pointer;border:1px solid transparent;transition:filter .12s,background .12s}
.apv-btn:disabled{opacity:.55;cursor:default}
.apv-deny{background:var(--panel2);border-color:var(--line2);color:var(--block)}
.apv-deny:not(:disabled):hover{background:var(--hover);border-color:var(--block)}
.apv-allow{background:var(--accent);border-color:var(--accent);color:#0b0b10}
.apv-allow:not(:disabled):hover{filter:brightness(1.08)}
`;
