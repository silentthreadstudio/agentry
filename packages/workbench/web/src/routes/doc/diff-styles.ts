// diff-styles — the before/after diff-drawer CSS, injected once (the same pattern DocDrawer uses).
// Ported from prototype-document.html's `.diff` block; every color reads a tokens.css variable (no new
// palette). Co-located here so the task-19 styling stays inside this task's owned file (no new .css file
// outside the contract). The drawer sits above the main column but leaves the 336px rail uncovered
// (`right:336px`), matching the prototype.
import { useEffect } from "react";

const STYLE_ID = "agentry-diff-styles";

export function useDiffStyles(): void {
  useEffect(() => {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = DIFF_CSS;
    document.head.appendChild(el);
  }, []);
}

const DIFF_CSS = `
.dd-diff{position:fixed;left:0;right:336px;bottom:0;z-index:90;transform:translateY(110%);
  transition:transform .28s cubic-bezier(.4,0,.2,1);background:var(--panel);border-top:1px solid var(--line2);
  box-shadow:0 -22px 50px rgba(0,0,0,.5);max-height:62%;display:flex;flex-direction:column}
.dd-diff.up{transform:translateY(0)}
.dd-overlay:not(:has(.dd-rail)) .dd-diff{right:0}
.dd-diff-h{display:flex;align-items:center;gap:10px;padding:13px 18px;border-bottom:1px solid var(--line)}
.dd-diff-h b{font-weight:650;font-size:13.5px;color:var(--ink)}
.dd-diff-tag{font:800 9.5px var(--sans);letter-spacing:.5px;text-transform:uppercase;color:var(--accent-ink);
  background:var(--accent-soft);border:1px solid color-mix(in srgb,var(--accent) 40%,transparent);
  border-radius:999px;padding:3px 9px}
.dd-diff-x{margin-left:auto;color:var(--faint);cursor:pointer;font-size:16px;background:none;border:0;padding:0}
.dd-diff-x:hover{color:var(--ink)}
.dd-diff-cols{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line);overflow:auto;min-height:0}
.dd-diff-c{background:var(--bg);padding:14px 18px}
.dd-diff-lab{font:700 10px var(--mono);letter-spacing:1px;text-transform:uppercase;color:var(--faint);margin-bottom:8px}
.dd-diff-c.before .dd-diff-lab{color:var(--block)}
.dd-diff-c.after .dd-diff-lab{color:var(--done)}
.dd-diff-text{font-size:13px;line-height:1.6;color:var(--ink);margin:.3em 0;white-space:pre-wrap;word-break:break-word}
.dd-diff-del{background:color-mix(in srgb,var(--block) 13%,transparent);text-decoration:line-through;
  text-decoration-color:color-mix(in srgb,var(--block) 60%,transparent);border-radius:3px;padding:0 2px}
.dd-diff-add{background:color-mix(in srgb,var(--done) 15%,transparent);border-radius:3px;padding:0 2px;color:var(--ink)}
.dd-diff-foot{display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid var(--line)}
.dd-diff-note{color:var(--muted);font-size:12px;flex:1}
.dd-bbtn{font:600 12.5px var(--sans);padding:8px 15px;border-radius:var(--r-md);border:1px solid var(--line2);
  background:var(--panel2);color:var(--ink);cursor:pointer}
.dd-bbtn:disabled{opacity:.5;cursor:not-allowed}
.dd-bbtn.deny{color:var(--block);border-color:color-mix(in srgb,var(--block) 40%,transparent)}
.dd-bbtn.iter{color:var(--rev);border-color:color-mix(in srgb,var(--rev) 40%,transparent)}
.dd-bbtn.accept{background:var(--done);border-color:transparent;color:#04210f;font-weight:700}
`;
