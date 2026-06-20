// DocEditor — the reusable document editor body (task 008, extracted from the retired DocDrawer's
// `DocBody`). It fetches the DocModel for one doc id, splits the frontmatter into a READ-ONLY typed header
// (status / version / lockedBy are FLOW-owned — ADR-004), and round-trips only the `body` through the
// three view modes the workspace header offers:
//   • Read   → rendered markdown (read-only prose; the default landing view).
//   • Edit   → Tiptap rich editor (task 14's mdToTiptap/tiptapToMd).
//   • Source → CodeMirror raw markdown (the byte-stable escape hatch).
// Save re-serializes via `tiptapToMd` then `normalize`, and POSTs `{ target, baseVersion, newBody }` to
// task 17's `/artifact` — echoing the OPAQUE `baseVersion` it was handed, never computing a version
// (ADR-006). Lock (ADR-006): an `in-progress` doc is read-only showing `lockedBy`; `todo`/`done` are
// editable; Take over flips the lock then re-fetches. ADRs (`adr-*`) are decision records — READ-ONLY in
// V1 (Save disabled), distinct from the agent lock.
//
// This is the EDITOR BODY only — no overlay, no fixed positioning. The Docs workspace mounts it in the
// center column of its three-column grid; it is the primary doc surface now that the drawer is retired.
// The `applyCommentMark` seam (the in-editor `comment` highlight a submitted review comment paints) is
// preserved via the module-level `liveEditor` ref, so the workspace's CommentRail paints without lifting
// the editor out of this component.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import type { DocModel } from "@agentry/workbench-shared";
import {
  mdToTiptap,
  normalize,
  tiptapToMd,
  type ProseMirrorDoc,
} from "../live/doc/markdown-serializer.js";
import { CommentMark } from "../live/doc/CommentMark.js";
import { LockBar } from "../live/doc/LockBar.js";
import { SourceMode } from "../live/doc/SourceMode.js";
import { kindGlyphOf } from "./doc-tree.js";

/**
 * Paint the `comment` mark over a DOM `Range` in the open editor (the in-editor highlight). The rail's
 * SelectionBubble holds the captured Range; on a submitted comment it calls this to highlight the span and
 * tag it with the comment id. The `comment` mark serializes to NOTHING (task 14), so the body round-trips
 * unchanged. A no-op when the editor isn't ready or the range can't map into ProseMirror coordinates.
 */
export type ApplyCommentMark = (range: Range, commentId: string) => void;

// The live Tiptap editor of the focused document, published so the shell-level CommentRail (a grid sibling
// of the editor column) can paint the in-editor highlight without prop-drilling across the grid boundary.
// Mirrors the old DocDrawer pattern; cleared when the body unmounts (tab close / doc switch).
let liveEditor: Editor | null = null;

function makeApplyCommentMark(): ApplyCommentMark {
  return (range, commentId) => {
    const editor = liveEditor;
    if (!editor) return;
    const { view } = editor;
    let from: number;
    let to: number;
    try {
      from = view.posAtDOM(range.startContainer, range.startOffset);
      to = view.posAtDOM(range.endContainer, range.endOffset);
    } catch {
      return; // the range isn't inside the editor's document — nothing to mark
    }
    if (from === to) return;
    editor
      .chain()
      .setTextSelection({ from: Math.min(from, to), to: Math.max(from, to) })
      .setMark("comment", { id: commentId })
      .run();
  };
}

// ── Doc fetch (GET /api/work/:id/doc/:docId → DocModel) ──────────────────────────────────────────────
async function fetchDoc(runId: string, docId: string, signal: AbortSignal): Promise<DocModel> {
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
interface SaveResult {
  ok: boolean;
  status: number;
  message: string;
}
async function postArtifact(
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

// FLOW frontmatter is loose (`Record<string, unknown>`); read a few known fields defensively (read-only).
function fmString(fm: Record<string, unknown>, key: string): string | null {
  const v = fm[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

type ViewMode = "read" | "edit" | "source";

/** What the workspace tab strip / rail need to know about a doc: its title + status (the dot). Published
 *  by DocEditor through `onLoaded` so the strip's tab can show the same status dot as the header pill. */
export interface DocMeta {
  title: string;
  status: string | null;
}

export interface DocEditorProps {
  runId: string;
  docId: string;
  /** The comment rail (the workspace's right column) — rendered by the parent, but DocEditor hands it the
   *  `applyCommentMark` so a submitted comment paints the in-editor highlight (AC5). */
  applyCommentMark: ApplyCommentMark;
  /** Fired once the doc loads (and on each reload) with its title/status — lets the tab strip label/dot it. */
  onLoaded?: (meta: DocMeta) => void;
}

type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; doc: DocModel };

export function DocEditor({ runId, docId, applyCommentMark, onLoaded }: DocEditorProps) {
  useDocEditorStyles();
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  const reload = useCallback(
    (signal: AbortSignal) => {
      setLoad({ kind: "loading" });
      fetchDoc(runId, docId, signal)
        .then((doc) => setLoad({ kind: "ready", doc }))
        .catch((err: unknown) => {
          if (signal.aborted) return;
          setLoad({ kind: "error", message: err instanceof Error ? err.message : "failed to load doc" });
        });
    },
    [runId, docId],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    reload(ctrl.signal);
    return () => ctrl.abort();
  }, [reload]);

  if (load.kind === "loading") {
    return <div className="de-state" aria-busy="true" />;
  }
  if (load.kind === "error") {
    return (
      <div className="de-state">
        <p className="de-muted">Couldn't open this document: {load.message}</p>
      </div>
    );
  }

  return (
    <DocBody
      key={docId}
      runId={runId}
      docId={docId}
      doc={load.doc}
      applyCommentMark={applyCommentMark}
      onLoaded={onLoaded}
      onReload={() => {
        const ctrl = new AbortController();
        reload(ctrl.signal);
      }}
    />
  );
}

// The loaded-doc body: header (read-only frontmatter + Read/Edit/Source segment + Take over), lock bar,
// the rich/source editor or rendered read view, save. Split out so its editor hooks mount only once a
// DocModel exists (and remount per docId via the `key`).
function DocBody({
  runId,
  docId,
  doc,
  applyCommentMark,
  onLoaded,
  onReload,
}: {
  runId: string;
  docId: string;
  doc: DocModel;
  applyCommentMark: ApplyCommentMark;
  onLoaded?: ((meta: DocMeta) => void) | undefined;
  onReload: () => void;
}) {
  const fm = doc.frontmatter;
  const status = fmString(fm, "status");
  // ADRs are decision records — READ-ONLY in V1 (the editable artifacts are spec/plan/task-<NNN>).
  const readOnly = docId.startsWith("adr-");
  // Locked = the agent holds it: an explicit lock, or `status: in-progress` (ADR-006).
  const locked = doc.lock != null || status === "in-progress";
  const editable = !locked && !readOnly;
  const lockedBy = doc.lock?.by ?? fmString(fm, "lockedBy") ?? fmString(fm, "assignee");
  const kindLabel = (fmString(fm, "kind") ?? fmString(fm, "type") ?? "Doc").toUpperCase();
  const title = fmString(fm, "title") ?? docId;
  const glyph = kindGlyphOf(docId);

  // Publish the doc's title/status to the tab strip (so the open tab can label + dot itself).
  useEffect(() => {
    onLoaded?.({ title, status });
  }, [onLoaded, title, status]);

  // Read is the default landing view; an editable doc still defaults to Read until the human picks Edit.
  const [mode, setMode] = useState<ViewMode>("read");
  const [rawBody, setRawBody] = useState<string>(() => normalize(doc.body));
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const editor = useEditor(
    {
      extensions: [StarterKit, Link.configure({ openOnClick: false }), CommentMark],
      content: mdToTiptap(doc.body) as ProseMirrorDoc,
      editable,
    },
    [docId],
  );

  // Publish this body's editor so the shell-level comment rail can paint the in-editor highlight.
  useEffect(() => {
    liveEditor = editor ?? null;
    return () => {
      if (liveEditor === editor) liveEditor = null;
    };
  }, [editor]);

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  const toRead = useCallback(() => setMode("read"), []);
  const toEdit = useCallback(() => setMode("edit"), []);
  const toSource = useCallback(() => {
    if (editor) setRawBody(normalize(tiptapToMd(editor.getJSON() as ProseMirrorDoc)));
    setMode("source");
  }, [editor]);

  // The body to persist, normalized identically on every path so a no-op edit is byte-stable (ADR-004/006).
  const currentBody = useCallback((): string => {
    if (mode === "source") return normalize(rawBody);
    return editor ? normalize(tiptapToMd(editor.getJSON() as ProseMirrorDoc)) : normalize(doc.body);
  }, [mode, rawBody, editor, doc.body]);

  async function save() {
    setSaving(true);
    setFeedback(null);
    const result = await postArtifact(runId, docId, doc.version, currentBody());
    setFeedback(result.message);
    setSaving(false);
    if (result.ok) onReload();
  }

  // The Read view renders the rich editor's HTML, read-only (a non-editable EditorContent), so the rendered
  // markdown and the Edit view share one schema/styling — no second markdown renderer to drift.

  return (
    <div className="de-root">
      <div className="de-hd">
        <span className="de-glyph" aria-hidden="true">{glyph}</span>
        <span className="de-titlecol">
          <span className="de-kind">{kindLabel} · {docId}</span>
          <h2 className="de-ttl">{title}</h2>
        </span>
        <span className="de-grow" />
        {readOnly ? (
          <span className="de-pill ro">read-only</span>
        ) : locked ? (
          <span className="de-pill lock">
            <span className="de-pdot" aria-hidden="true" />
            {lockedBy ?? "agent"} writing
          </span>
        ) : (
          <span className="de-pill ok">
            <span className="de-pdot" aria-hidden="true" />
            editable
          </span>
        )}
        <span className="de-ver">{doc.version || "—"}</span>
        <div className="de-seg" role="group" aria-label="View mode">
          <button type="button" className={`de-seg-b${mode === "read" ? " on" : ""}`} onClick={toRead}>
            Read
          </button>
          <button
            type="button"
            className={`de-seg-b${mode === "edit" ? " on" : ""}`}
            onClick={toEdit}
            disabled={!editable}
            title={editable ? undefined : "This document is read-only"}
          >
            Edit
          </button>
          <button type="button" className={`de-seg-b${mode === "source" ? " on" : ""}`} onClick={toSource}>
            Source
          </button>
        </div>
      </div>

      {locked || !readOnly ? (
        <LockBar
          locked={locked}
          lockedBy={lockedBy}
          version={doc.version}
          runId={runId}
          docId={docId}
          onTakenOver={onReload}
        />
      ) : null}

      {mode !== "read" ? (
        <div className="de-toolbar">
          {mode === "edit" ? (
            <RichToolbar editor={editor} disabled={!editable} />
          ) : (
            <span className="de-muted">raw markdown — serializer bypassed</span>
          )}
          <span className="de-grow" />
          <button type="button" className="de-save" onClick={save} disabled={!editable || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      ) : null}

      {feedback ? (
        <div className="de-feedback" role="status">
          {feedback}
        </div>
      ) : null}

      <div className="de-body">
        {mode === "source" ? (
          <div className="de-source">
            <SourceMode value={rawBody} onChange={setRawBody} readOnly={!editable} />
          </div>
        ) : (
          <div className={`dd-prose${mode === "edit" && editable ? "" : " locked"}`}>
            <EditorContent editor={editor} />
          </div>
        )}
      </div>
    </div>
  );
}

// Surfaces the editor for the rail's applyCommentMark — re-exported so the workspace builds the callback
// once and threads it down (stable identity across renders).
export function useApplyCommentMark(): ApplyCommentMark {
  return useMemo(() => makeApplyCommentMark(), []);
}

// ── Rich toolbar — bold/italic/H2/bullet/code marks, aligned to the serializer schema ──
function RichToolbar({ editor, disabled }: { editor: ReturnType<typeof useEditor>; disabled: boolean }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const bump = () => force((n) => n + 1);
    editor.on("transaction", bump);
    return () => {
      editor.off("transaction", bump);
    };
  }, [editor]);

  if (!editor) return null;
  const can = !disabled && editor.isEditable;
  const btn = (active: boolean, label: ReactNode, run: () => void, key: string) => (
    <button
      key={key}
      type="button"
      className={`dd-tb${active ? " on" : ""}`}
      disabled={!can}
      onClick={() => run()}
    >
      {label}
    </button>
  );

  return (
    <div className="dd-marks" role="group" aria-label="Formatting">
      {btn(editor.isActive("bold"), <b>B</b>, () => editor.chain().focus().toggleBold().run(), "bold")}
      {btn(editor.isActive("italic"), <i>I</i>, () => editor.chain().focus().toggleItalic().run(), "italic")}
      {btn(
        editor.isActive("heading", { level: 2 }),
        "H2",
        () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
        "h2",
      )}
      {btn(editor.isActive("bulletList"), "•", () => editor.chain().focus().toggleBulletList().run(), "bullet")}
      {btn(editor.isActive("code"), "</>", () => editor.chain().focus().toggleCode().run(), "code")}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────────────────────────────
// The editor-body styles (header + toolbar + prose), ported from the retired DocDrawer's DOC_CSS and the
// mockup's `.ehd`/`.seg`/`.docbody` block — every color reads a tokens.css variable (no new palette). The
// `.dd-prose .ProseMirror …` descendant selectors stay (the rail + bubble + comment styles key on them).
const STYLE_ID = "agentry-doceditor-styles";
function useDocEditorStyles(): void {
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
