// docs-styles — the Docs workspace chrome styles (task 008), injected once. Covers the three-column grid,
// the navigator (`.nv-*`), the editor tab strip (`.dw-*`), and the conversation rail frame (`.dr-*`),
// ported from the mockup (design/doc-workspace.html). Every color reads a tokens.css variable — no new
// palette. The DocEditor body + the comment rail / bubble / diff bring their own (already-injected) styles.
import { useEffect } from "react";

function injectOnce(id: string, css: string): void {
  if (document.getElementById(id)) return;
  const el = document.createElement("style");
  el.id = id;
  el.textContent = css;
  document.head.appendChild(el);
}

const WORKSPACE_STYLE_ID = "agentry-docs-workspace-styles";
export function useDocsWorkspaceStyles(): void {
  useEffect(() => injectOnce(WORKSPACE_STYLE_ID, WORKSPACE_CSS), []);
}

const RAIL_STYLE_ID = "agentry-docs-rail-styles";
export function useDocsRailStyles(): void {
  useEffect(() => injectOnce(RAIL_STYLE_ID, RAIL_CSS), []);
}

const WORKSPACE_CSS = `
/* three-column grid: navigator | editor | conversation */
.dw-grid{height:100%;display:grid;grid-template-columns:236px 1fr 392px;min-height:0;min-width:0;overflow:hidden}

/* navigator */
.nv-root{border-right:1px solid var(--line);background:var(--side-bg,var(--bg));display:flex;flex-direction:column;min-height:0;min-width:0}
.nv-hd{display:flex;align-items:center;gap:6px;padding:12px 13px 8px}
.nv-seg{display:flex;border:1px solid var(--line2);border-radius:var(--r-md);overflow:hidden;background:var(--panel);font-size:11.5px}
.nv-seg-b{padding:5px 11px;color:var(--muted);cursor:pointer;background:transparent;border:0;font-family:var(--sans)}
.nv-seg-b:hover{color:var(--ink)}
.nv-seg-b.on{background:var(--raise);color:var(--ink)}
.nv-tree{flex:1;overflow:auto;padding:6px 8px}
.nv-graph{flex:1;min-height:0;position:relative;display:flex}
.nv-graph .flowwrap{flex:1;min-height:0}
.nv-empty{color:var(--faint);font-size:12px;text-align:center;padding:30px 12px}
.nv-grp{font:700 9.5px var(--sans);letter-spacing:.7px;text-transform:uppercase;color:var(--faint);padding:11px 9px 5px}
.nv-item{display:flex;align-items:center;gap:9px;padding:6px 9px;border-radius:var(--r-md);cursor:pointer;
  color:var(--ink2);font-size:12.5px;width:100%;text-align:left;background:transparent;border:0;font-family:var(--sans)}
.nv-item:hover{background:var(--hover)}
.nv-item.on{background:var(--accent-soft);color:#fff;box-shadow:inset 0 0 0 1px var(--accent-line)}
.nv-g{width:15px;text-align:center;color:var(--faint);font-size:12px;flex:none}
.nv-item.on .nv-g{color:var(--accent-ink)}
.nv-nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nv-sd{width:7px;height:7px;border-radius:50%;flex:none}
.nv-review{margin:8px;padding:10px;border:1px solid var(--accent-line);border-radius:var(--r-lg);
  background:linear-gradient(160deg,color-mix(in srgb,var(--accent) 16%,var(--bg)),var(--panel));text-align:center}
.nv-review b{font-size:12px;color:#fff}
.nv-review p{margin:3px 0 8px;font-size:11px;color:var(--muted)}
.nv-review button{width:100%;font:600 12px var(--sans);border:0;border-radius:var(--r-md);padding:8px;cursor:pointer;
  color:#fff;background:linear-gradient(120deg,var(--v1),var(--v2))}

/* editor column + tab strip */
.dw-ed{display:flex;flex-direction:column;min-width:0;min-height:0}
.dw-tabbar{display:flex;align-items:stretch;border-bottom:1px solid var(--line);background:var(--side-bg,var(--bg));overflow-x:auto;flex:none}
.dw-tab{display:flex;align-items:center;gap:8px;padding:9px 13px;border-right:1px solid var(--line);
  font-size:12.5px;color:var(--muted);cursor:pointer;white-space:nowrap;background:transparent;border-top:0;border-bottom:0;
  font-family:var(--sans)}
.dw-tab.on{background:var(--bg);color:var(--ink);box-shadow:inset 0 -2px 0 var(--accent)}
.dw-tab-sd{width:6px;height:6px;border-radius:50%;flex:none}
.dw-tab-x{color:var(--faint);font-size:13px;cursor:pointer;background:none;border:0;padding:0 0 0 2px;line-height:1;font-family:var(--sans)}
.dw-tab-x:hover{color:var(--ink)}
.dw-edbody{flex:1;min-height:0;display:flex;flex-direction:column}
.dw-empty{flex:1;display:grid;place-items:center;padding:40px;color:var(--muted);font-size:13px;text-align:center;line-height:1.7}

/* review walk-through banner (a stub strip above the editor when active) */
.dw-walk{display:flex;align-items:center;gap:12px;padding:9px 16px;border-bottom:1px solid var(--line);
  background:color-mix(in srgb,var(--accent) 9%,var(--panel));font-size:12px;color:var(--ink2);flex:none}
.dw-walk b{color:var(--ink)}
.dw-walk .grow{flex:1}
.dw-walk button{font:600 11.5px var(--sans);border:1px solid var(--line2);background:var(--panel2);color:var(--ink2);
  border-radius:var(--r-sm);padding:5px 11px;cursor:pointer}
.dw-walk button:disabled{opacity:.4;cursor:not-allowed}
`;

const RAIL_CSS = `
.dr-root{border-left:1px solid var(--line);background:var(--side-bg,var(--bg));display:flex;flex-direction:column;min-height:0;min-width:0;position:relative}
.dr-hd{display:flex;align-items:center;gap:9px;padding:13px 15px;border-bottom:1px solid var(--line);flex:none}
.dr-hd b{font-size:13px;font-weight:650}
.dr-count{font:600 10px var(--sans);color:var(--accent-ink);background:var(--accent-soft);
  border:1px solid var(--accent-line);border-radius:999px;padding:2px 7px}
.dr-ask{margin-left:auto;font:600 11px var(--sans);border:0;border-radius:var(--r-md);padding:6px 10px;cursor:pointer;
  color:#fff;background:linear-gradient(120deg,var(--v1),var(--v2))}
.dr-ask:disabled{opacity:.45;cursor:not-allowed}
.dr-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
`;
