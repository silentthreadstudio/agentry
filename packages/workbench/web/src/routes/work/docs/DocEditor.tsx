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
import { fetchDoc, fmString, postArtifact, postStatus } from "./doc-io.js";
import { useDocEditorStyles } from "./doc-editor-styles.js";

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

// Two view modes only: Read (rendered markdown) and Source (raw markdown — the edit path). The rich Edit
// mode was removed (you edit in Source, or ask the agent for changes — cleanup note 2).
type ViewMode = "read" | "source";

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

  // The Read view renders this editor read-only (editing is Source-only now), so it's never `editable` —
  // it exists to render markdown + carry the comment highlights. `editable` (below) gates Source's Save.
  const editor = useEditor(
    {
      extensions: [StarterKit, Link.configure({ openOnClick: false }), CommentMark],
      content: mdToTiptap(doc.body) as ProseMirrorDoc,
      editable: false,
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

  const toRead = useCallback(() => setMode("read"), []);
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

  // Set a task's status (the header select) — POST the new FLOW status, then reload so the header pill /
  // lock state re-derive. A no-op if it didn't change. Tasks only (the select renders only for task docs).
  async function changeStatus(next: string) {
    if (next === status) return;
    const ok = await postStatus(runId, docId, next);
    setFeedback(ok ? `Status → ${next}.` : "Couldn't update status.");
    if (ok) onReload();
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
        {/* Task status override (cleanup note 3): agents sometimes don't move a task to done — let the
            human set it. Only on task docs; writes the FLOW frontmatter `status` then reloads. */}
        {docId.startsWith("task-") ? (
          <select
            className="de-status"
            aria-label="Task status"
            value={status ?? "todo"}
            onChange={(e) => void changeStatus(e.target.value)}
          >
            <option value="todo">To do</option>
            <option value="in-progress">In progress</option>
            <option value="in-review">In review</option>
            <option value="done">Done</option>
          </select>
        ) : null}
        <div className="de-seg" role="group" aria-label="View mode">
          <button type="button" className={`de-seg-b${mode === "read" ? " on" : ""}`} onClick={toRead}>
            Read
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

      {mode === "source" ? (
        <div className="de-toolbar">
          <span className="de-muted">raw markdown — serializer bypassed</span>
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
          // Read view: the rendered markdown, always non-interactive (editing is Source-only now).
          <div className="dd-prose locked">
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
