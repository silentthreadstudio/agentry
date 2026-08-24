// doc-editor-styles — the DocEditor chrome styles (header + status select + source toolbar + prose),
// injected once. Extracted from DocEditor.tsx to match the house pattern (comment-styles / docs-styles /
// diff-styles all live in dedicated *-styles modules). Every color reads a tokens.css variable (no new
// palette). The `.dd-prose .ProseMirror …` descendant selectors stay here (the rail + comment marks key
// on them) — the read view and the comment highlights share this one prose styling.
import { useEffect } from "react";

const STYLE_ID = "agentry-doceditor-styles";

export function useDocEditorStyles(): void {
  useEffect(() => {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = DOC_CSS;
    document.head.appendChild(el);
  }, []);
}

const DOC_CSS = `
.de-root{display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;background:var(--bg)}
.de-state{flex:1;display:grid;place-items:center;padding:40px}
.de-muted{color:var(--muted);font-size:12.5px}

.de-hd{display:flex;align-items:center;gap:11px;padding:13px 24px;border-bottom:1px solid var(--line);
  background:var(--bg)}
.de-glyph{width:24px;height:24px;border-radius:7px;display:grid;place-items:center;font-size:12px;
  background:var(--accent-soft);border:1px solid var(--accent-line);color:var(--accent-ink);flex:none}
.de-titlecol{display:flex;flex-direction:column;gap:1px;min-width:0}
.de-kind{font:600 9.5px var(--sans);letter-spacing:.5px;text-transform:uppercase;color:var(--faint)}
.de-ttl{margin:0;font-size:15px;font-weight:650;letter-spacing:-.2px;color:var(--ink);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.de-grow{flex:1}
.de-pill{display:inline-flex;align-items:center;gap:6px;font:600 11px var(--sans);padding:4px 10px;
  border-radius:999px;white-space:nowrap}
.de-pill .de-pdot{width:7px;height:7px;border-radius:50%;flex:none;background:currentColor}
.de-pill.ok{color:var(--done);background:color-mix(in srgb,var(--done) 12%,transparent);
  border:1px solid color-mix(in srgb,var(--done) 30%,transparent)}
.de-pill.lock{color:var(--prog);background:color-mix(in srgb,var(--prog) 12%,transparent);
  border:1px solid color-mix(in srgb,var(--prog) 30%,transparent)}
.de-pill.ro{color:var(--muted);background:var(--panel2);border:1px solid var(--line2)}
.de-ver{font:600 11px var(--mono);color:var(--faint)}
.de-seg{display:flex;border:1px solid var(--line2);border-radius:var(--r-md);overflow:hidden;background:var(--panel2)}
.de-seg-b{padding:6px 11px;font-size:12px;color:var(--muted);cursor:pointer;background:transparent;border:0;
  font-family:var(--sans)}
.de-seg-b:hover:not(:disabled){color:var(--ink)}
.de-seg-b.on{background:var(--raise);color:var(--ink)}
.de-seg-b:disabled{opacity:.4;cursor:not-allowed}
.de-status{appearance:none;font:600 11.5px var(--sans);color:var(--ink);background:var(--panel2);
  border:1px solid var(--line2);border-radius:var(--r-md);padding:6px 26px 6px 11px;cursor:pointer;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%238a8b98' stroke-width='3' stroke-linecap='round'><path d='M6 9l6 6 6-6'/></svg>");
  background-repeat:no-repeat;background-position:right 9px center}
.de-status:hover{border-color:var(--accent-line)}
.de-status:focus{outline:none;border-color:var(--accent-line)}

.de-toolbar{display:flex;align-items:center;gap:8px;padding:7px 16px;border-bottom:1px solid var(--line);
  background:var(--panel)}
.de-save{height:28px;padding:0 14px;border-radius:var(--r-md);border:1px solid transparent;cursor:pointer;
  background:var(--ink);color:var(--bg);font-weight:650;font-size:12.5px;font-family:var(--sans)}
.de-save:disabled{opacity:.4;cursor:not-allowed}
.de-feedback{padding:7px 24px;font-size:12px;color:var(--muted);background:var(--panel2);border-bottom:1px solid var(--line)}

.de-body{flex:1;overflow:auto;display:flex;justify-content:center;padding:30px 24px 80px}
.de-source{max-width:760px;width:100%}
.dd-prose{max-width:760px;width:100%}
.dd-prose .ProseMirror{outline:none;color:#d6d6e2;line-height:1.62;font-size:14.5px}
.dd-prose.locked .ProseMirror{opacity:.92}
.dd-prose .ProseMirror:focus{outline:none}
.dd-prose .ProseMirror h1{font-size:23px;letter-spacing:-.3px;margin:.1em 0 .55em;color:var(--ink)}
.dd-prose .ProseMirror h2{font-size:16.5px;margin:1.5em 0 .4em;color:var(--ink)}
.dd-prose .ProseMirror h3{font-size:14px;margin:1.2em 0 .3em;color:var(--ink)}
.dd-prose .ProseMirror p{margin:.5em 0}
.dd-prose .ProseMirror ul,.dd-prose .ProseMirror ol{padding-left:1.2em}
.dd-prose .ProseMirror a{color:var(--accent-ink);text-decoration:underline}
.dd-prose .ProseMirror code{font-family:var(--mono);font-size:12.5px;background:var(--panel2);
  border:1px solid var(--line2);border-radius:5px;padding:1px 5px;color:var(--rev)}
.dd-prose .ProseMirror pre{background:var(--panel2);border:1px solid var(--line);border-radius:var(--r-lg);
  padding:13px 15px;overflow:auto}
.dd-prose .ProseMirror pre code{background:none;border:0;padding:0;color:#cbd2dd}
.dd-prose .ProseMirror blockquote{border-left:3px solid var(--accent);margin:.6em 0;padding:.1em 0 .1em 14px;color:var(--muted)}
`;
