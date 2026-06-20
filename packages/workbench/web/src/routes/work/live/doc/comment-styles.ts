// comment-styles — the rail + selection-bubble + comment-mark CSS, injected once (the same pattern
// DocDrawer uses for its descendant selectors). Ported from prototype-document.html's `.rail` / `.bubble`
// / `.cmt-mark` blocks; every color reads a tokens.css variable (no new palette). Co-located here so the
// task-18 styling stays inside this task's owned files (no new .css file outside the contract).
import { useEffect } from "react";

const STYLE_ID = "agentry-comment-styles";

export function useCommentRailStyles(): void {
  useEffect(() => {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = COMMENT_CSS;
    document.head.appendChild(el);
  }, []);
}

const COMMENT_CSS = `
/* comment mark inside the editor (CommentMark renders span.cmt-mark) */
.dd-prose .ProseMirror .cmt-mark{background:color-mix(in srgb,var(--prog) 16%,transparent);
  border-bottom:2px solid var(--prog);border-radius:3px;padding:0 1px;cursor:pointer;transition:background .12s}
.dd-prose .ProseMirror .cmt-mark:hover{background:color-mix(in srgb,var(--prog) 32%,transparent)}

/* the rail */
.dd-railwrap{display:flex;flex-direction:column;min-width:0;height:100%}
.dd-rail-h{padding:12px 15px;border-bottom:1px solid var(--line);display:flex;align-items:center;
  justify-content:space-between;gap:8px}
.dd-rail-t{font:700 11px var(--sans);letter-spacing:.6px;text-transform:uppercase;color:var(--faint)}
.dd-gatepill{font:800 9.5px var(--sans);letter-spacing:.4px;text-transform:uppercase;color:var(--prog);
  background:color-mix(in srgb,var(--prog) 12%,transparent);border:1px solid color-mix(in srgb,var(--prog) 40%,transparent);
  border-radius:999px;padding:3px 9px;white-space:nowrap}
.dd-rail-body{flex:1;overflow:auto;padding:10px 11px 24px}
.dd-rail-empty{color:var(--faint);font-size:12px;text-align:center;padding:30px 16px;line-height:1.6}

.dd-cmt{border:1px solid var(--line);border-radius:var(--r-lg);background:var(--panel);padding:11px;
  margin-bottom:9px;transition:border-color .12s}
.dd-cmt:hover{border-color:var(--line2)}
.dd-cmt.resolved{opacity:.55}
.dd-cmt.changes{border-left:3px solid var(--coral,var(--block))}
.dd-cmt.approve{border-left:3px solid var(--done)}
.dd-cmt.question{border-left:3px solid var(--rev)}
.dd-cmt-top{display:flex;align-items:center;gap:7px;margin-bottom:5px}
.dd-cmt-dec{font:800 9px var(--sans);letter-spacing:.6px;text-transform:uppercase}
.d-changes{color:var(--coral,var(--block))}
.d-approve{color:var(--done)}
.d-question{color:var(--rev)}
.dd-cmt-who{margin-left:auto;color:var(--muted);font-size:11px}
.dd-cmt-q{font:500 10.5px var(--mono);color:var(--faint);border-left:2px solid var(--line2);
  padding-left:7px;margin:4px 0;word-break:break-word}
.dd-cmt-bd{font-size:12.5px;color:var(--ink)}
.dd-cmt-meta{display:flex;gap:10px;margin-top:6px;font:600 10px var(--mono);color:var(--faint)}
.dd-cmt-ax{display:flex;gap:6px;margin-top:9px}
.dd-cmt-resolved{font:700 10px var(--sans);color:var(--done)}
.dd-mini{font:600 11px var(--sans);padding:4px 10px;border-radius:var(--r-md);border:1px solid var(--line2);
  background:var(--panel2);color:var(--muted);cursor:pointer}
.dd-mini:hover{color:var(--ink);border-color:var(--line2)}

/* an agent channel_reply (Phase 2b), nested in its human comment's card — tinted reply block
   (mockup .reply / .ava.ag). Display-only: the human acts via Resolve + the diff drawer. */
.dd-reply{margin:9px -11px -11px;padding:9px 11px;border-top:1px solid var(--line);
  background:color-mix(in srgb,var(--done) 7%,transparent)}
.dd-reply-top{display:flex;align-items:center;gap:6px;margin-bottom:4px}
.dd-reply-ava{width:18px;height:18px;border-radius:50%;display:grid;place-items:center;flex:none;
  font:800 9px var(--sans);color:var(--done);background:color-mix(in srgb,var(--done) 16%,transparent);
  border:1px solid color-mix(in srgb,var(--done) 40%,transparent)}
.dd-reply-who{font:600 11.5px var(--sans);color:var(--ink)}
.dd-reply-when{font-size:10.5px;color:var(--faint)}
.dd-reply-bd{font-size:12px;color:var(--ink2);word-break:break-word}

/* fallback flat "replies" area — agent replies whose replyTo points at no known human comment */
.dd-orphans{margin-top:6px;border-top:1px dashed var(--line2);padding-top:8px}
.dd-orphans-h{font:700 9px var(--sans);letter-spacing:.6px;text-transform:uppercase;color:var(--faint);
  margin-bottom:6px}
.dd-orphans .dd-reply{margin:0 0 8px;border:1px solid var(--line);border-radius:var(--r-lg)}

/* the floating selection composer — a small card: textarea + a row of decision buttons */
.dd-bubble{position:fixed;z-index:90;display:flex;flex-direction:column;gap:7px;width:300px;
  transform:translate(-50%,-118%);background:var(--panel2);border:1px solid var(--line2);
  border-radius:var(--r-lg);padding:9px;box-shadow:0 16px 40px rgba(0,0,0,.55)}
.dd-bubble-ta{width:100%;box-sizing:border-box;min-height:58px;resize:vertical;font:400 12.5px var(--sans);
  color:var(--ink);background:var(--panel);border:1px solid var(--line2);border-radius:var(--r-md);
  padding:7px 9px;line-height:1.5}
.dd-bubble-ta::placeholder{color:var(--faint)}
.dd-bubble-ta:focus{outline:none;border-color:var(--prog)}
.dd-bubble-row{display:flex;gap:3px;justify-content:space-between}
.dd-bubble-btn{border:0;background:transparent;color:var(--ink);font-size:11.5px;font-weight:600;
  padding:5px 8px;border-radius:var(--r-md);cursor:pointer;display:flex;align-items:center;gap:5px;
  font-family:var(--sans);white-space:nowrap}
.dd-bubble-btn:hover:not(:disabled){background:var(--hover)}
.dd-bubble-btn:disabled{opacity:.5;cursor:default}
.dd-bubble-btn.acc{color:var(--done)}
.dd-bubble-btn.chg{color:var(--coral,var(--block))}
.dd-bubble-btn.qz{color:var(--rev)}
`;
