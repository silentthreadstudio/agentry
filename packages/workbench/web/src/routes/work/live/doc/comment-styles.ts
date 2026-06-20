// comment-styles — the conversation rail + composer + gutter-trigger + comment-mark CSS, injected once
// (the same pattern DocEditor uses). Ported from design/right-pane.html; every color reads a tokens.css
// variable (no new palette). Co-located here so the comment-loop styling stays inside its owned files.
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

/* ── rail shell + header + filter ─────────────────────────────────────────────────────────────── */
.dd-railwrap{display:flex;flex-direction:column;min-width:0;height:100%}
.dd-rail-h{display:flex;align-items:center;gap:9px;padding:13px 14px 12px;border-bottom:1px solid var(--line)}
.dd-rail-t{font-size:13.5px;font-weight:650;letter-spacing:-.1px;color:var(--ink)}
.dd-gatepill{font:700 9px var(--sans);letter-spacing:.5px;text-transform:uppercase;color:var(--accent-ink);
  background:var(--accent-soft);border:1px solid var(--accent-line);border-radius:999px;padding:3px 8px;white-space:nowrap}
.dd-rail-grow{flex:1}
.dd-filter{display:flex;background:var(--panel2);border:1px solid var(--line2);border-radius:999px;padding:2px}
.dd-filter button{border:0;background:transparent;color:var(--muted);font:600 10.5px var(--sans);
  padding:4px 10px;border-radius:999px;cursor:pointer}
.dd-filter button.on{background:var(--raise);color:var(--ink)}
.dd-rail-body{flex:1;overflow:auto;padding:8px 8px 16px;display:flex;flex-direction:column;gap:7px}
.dd-rail-empty{color:var(--faint);font-size:12px;text-align:center;padding:34px 18px;line-height:1.7;margin:auto}
.dd-rail-empty b{color:var(--ink2)}

/* ── a thread (root + replies + reply box) ────────────────────────────────────────────────────── */
.dd-thread{border:1px solid var(--line);border-radius:var(--r-lg);background:var(--panel);overflow:hidden}
.dd-thread.changes{border-left:2px solid var(--block)}
.dd-thread.question{border-left:2px solid var(--rev)}
.dd-thread.approve{border-left:2px solid var(--done)}
.dd-thread.resolved{opacity:.6}
.dd-th-hd{display:flex;align-items:center;gap:8px;padding:8px 10px}
.dd-th-dec{font:800 8.5px var(--sans);letter-spacing:.5px;text-transform:uppercase;padding:2px 7px;border-radius:999px;flex:none}
.dd-th-dec.changes{color:var(--block);background:color-mix(in srgb,var(--block) 13%,transparent)}
.dd-th-dec.question{color:var(--rev);background:color-mix(in srgb,var(--rev) 13%,transparent)}
.dd-th-dec.approve{color:var(--done);background:color-mix(in srgb,var(--done) 13%,transparent)}
.dd-th-quote{flex:1;min-width:0;font:500 10.5px var(--mono);color:var(--muted);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dd-th-loc{font:600 9.5px var(--mono);color:var(--faint);white-space:nowrap}
/* long selection → a clickable line-range chip; click expands the full span */
.dd-th-range{flex:1;min-width:0;display:flex;align-items:center;gap:5px;background:none;border:0;cursor:pointer;
  font:600 10px var(--mono);color:var(--accent-ink);padding:0;text-align:left}
.dd-th-range .chip{background:var(--accent-soft);border:1px solid var(--accent-line);border-radius:var(--r-sm);
  padding:2px 7px;letter-spacing:.3px;flex:none}
.dd-th-range .hint{color:var(--faint);font:500 10.5px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dd-th-range .chev{color:var(--faint);transition:transform .15s;flex:none}
.dd-th-range[aria-expanded="true"] .chev{transform:rotate(90deg)}
.dd-th-full{font:500 11px var(--mono);color:var(--ink2);line-height:1.55;border-left:2px solid var(--accent);
  margin:0 10px 8px;padding:7px 0 7px 9px;white-space:pre-wrap;word-break:break-word}
.dd-th-resolve{border:1px solid var(--line2);background:var(--panel2);color:var(--muted);font:600 10.5px var(--sans);
  padding:4px 9px;border-radius:var(--r-sm);cursor:pointer;white-space:nowrap}
.dd-th-resolve:hover{color:var(--done);border-color:color-mix(in srgb,var(--done) 33%,transparent)}
.dd-th-resolved{font:700 10px var(--sans);color:var(--done);white-space:nowrap}

/* messages — chat-style, avatar gutter */
.dd-msgs{display:flex;flex-direction:column;padding:0 10px 6px;border-top:1px solid var(--line)}
.dd-msg{display:flex;gap:8px;padding:7px 0}
.dd-msg + .dd-msg{border-top:1px solid var(--line)}
.dd-ava{width:22px;height:22px;border-radius:50%;flex:none;display:grid;place-items:center;font:800 8px var(--sans);margin-top:1px}
.dd-ava.you{color:#fff;background:linear-gradient(140deg,var(--rev),#3f6fd0)}
.dd-ava.ag{color:var(--accent-ink);background:color-mix(in srgb,var(--accent) 15%,transparent);
  border:1px solid var(--accent-line);font-size:11px}
.dd-mcol{flex:1;min-width:0}
.dd-who{display:flex;align-items:center;gap:6px;margin-bottom:2px}
.dd-nm{font:650 11.5px var(--sans);color:var(--ink)}
.dd-nm.ag{color:var(--accent-ink)}
.dd-when{font:500 10px var(--sans);color:var(--faint)}
.dd-bd{font-size:12.5px;color:var(--ink2);line-height:1.5;word-break:break-word;white-space:pre-wrap}
.dd-msg.agent .dd-bd{color:var(--ink)}

/* reply box — the human answering inline */
.dd-reply{display:flex;align-items:flex-end;gap:7px;padding:8px 10px 10px;border-top:1px solid var(--line);background:var(--bg2)}
.dd-reply textarea{flex:1;min-height:32px;max-height:90px;resize:none;font:400 12px var(--sans);color:var(--ink);
  background:var(--panel);border:1px solid var(--line2);border-radius:var(--r-md);padding:7px 9px;line-height:1.45}
.dd-reply textarea::placeholder{color:var(--faint)}
.dd-reply textarea:focus{outline:none;border-color:var(--accent-line)}
.dd-send{flex:none;width:32px;height:32px;border-radius:var(--r-md);border:0;cursor:pointer;color:#fff;
  background:linear-gradient(120deg,var(--v1),var(--v2));display:grid;place-items:center}
.dd-send:disabled{opacity:.45;cursor:default}
.dd-send svg{width:15px;height:15px}

/* fallback flat "replies" area — replies whose replyTo points at no known root */
.dd-orphans{margin-top:4px;border-top:1px dashed var(--line2);padding-top:8px}
.dd-orphans-h{font:700 9px var(--sans);letter-spacing:.6px;text-transform:uppercase;color:var(--faint);
  margin-bottom:6px;padding:0 4px}
.dd-orphans .dd-msg{padding:7px 8px;border:1px solid var(--line);border-radius:var(--r-lg);margin-bottom:6px}
.dd-orphans .dd-msg + .dd-msg{border-top:1px solid var(--line)}

/* ── the margin trigger — filled-purple labeled pill (no emoji) ───────────────────────────────── */
.dd-gutter-btn{position:fixed;z-index:90;display:flex;align-items:center;gap:6px;padding:6px 12px 6px 10px;
  border-radius:999px;cursor:pointer;font:600 12px var(--sans);color:#fff;border:0;
  background:linear-gradient(120deg,var(--v1),var(--v2));
  box-shadow:0 8px 22px rgba(0,0,0,.4),0 0 0 3px color-mix(in srgb,var(--accent) 16%,transparent);
  transition:transform .12s,box-shadow .12s}
.dd-gutter-btn:hover{transform:translateY(-1px);
  box-shadow:0 12px 28px rgba(0,0,0,.5),0 0 0 4px color-mix(in srgb,var(--accent) 25%,transparent)}
.dd-gutter-btn svg{width:14px;height:14px;display:block}

/* ── the in-rail composer (opened by the margin button) ───────────────────────────────────────── */
.dd-composer{border:1px solid var(--accent-line);border-radius:var(--r-lg);
  background:linear-gradient(180deg,var(--accent-soft),var(--panel));padding:10px;box-shadow:0 8px 24px rgba(0,0,0,.36)}
.dd-composer-h{display:flex;align-items:center;margin-bottom:7px}
.dd-composer-t{font:700 9px var(--sans);letter-spacing:.6px;text-transform:uppercase;color:var(--accent-ink)}
.dd-composer-x{margin-left:auto;border:0;background:transparent;color:var(--faint);font-size:16px;line-height:1;cursor:pointer;padding:0 2px}
.dd-composer-x:hover{color:var(--ink)}
.dd-composer-q{font:500 10.5px var(--mono);color:var(--ink2);border-left:2px solid var(--accent);
  padding-left:8px;margin-bottom:8px;max-height:52px;overflow:auto;word-break:break-word}
.dd-composer-ta{width:100%;box-sizing:border-box;min-height:56px;resize:vertical;font:400 12.5px var(--sans);color:var(--ink);
  background:var(--bg);border:1px solid var(--line2);border-radius:var(--r-md);padding:8px 9px;line-height:1.5;margin-bottom:8px}
.dd-composer-ta::placeholder{color:var(--faint)}
.dd-composer-ta:focus{outline:none;border-color:var(--accent-line)}
.dd-composer-row{display:flex;gap:5px}

/* decision buttons — shared by the composer row */
.dd-bubble-btn{flex:1;justify-content:center;border:1px solid var(--line2);background:var(--panel2);color:var(--ink);
  font:600 11.5px var(--sans);padding:7px 6px;border-radius:var(--r-md);cursor:pointer;display:flex;align-items:center;gap:5px;white-space:nowrap}
.dd-bubble-btn:hover:not(:disabled){border-color:var(--accent-line)}
.dd-bubble-btn:disabled{opacity:.5;cursor:default}
.dd-bubble-btn.acc{color:var(--done)}
.dd-bubble-btn.chg{color:var(--block)}
.dd-bubble-btn.qz{color:var(--rev)}
`;
