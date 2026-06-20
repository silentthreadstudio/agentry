// approvals-styles — the ApprovalsBanner's injected CSS, split out to the house *-styles.ts pattern
// (comment-styles / diff-styles / docs-styles). The ui-v2 language: a layered-black card with the accent
// border-glow, fixed bottom-right so it floats over any route without shifting layout. The one place a
// touch of urgency is sanctioned — Allow uses the accent, Deny a restrained red (--block). Every color
// reads a tokens.css var; no new palette.
import { useEffect } from "react";

const STYLE_ID = "agentry-approvals-styles";

export function useApprovalsStyles(): void {
  useEffect(() => {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = APPROVALS_CSS;
    document.head.appendChild(el);
  }, []);
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
