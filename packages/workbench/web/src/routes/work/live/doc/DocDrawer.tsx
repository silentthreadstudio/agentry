// DocDrawer — the document drawer over the dimmed Panorama (AC4, ported from prototype-document.html).
// A node click selects a doc (the seam this module exports); the drawer fetches the DocModel, splits the
// frontmatter into a READ-ONLY typed header (status / version / lockedBy are FLOW-owned, never editable —
// ADR-004), and round-trips only the `body` through Tiptap (task 14's `mdToTiptap`/`tiptapToMd`). Save
// re-serializes via `tiptapToMd` then `normalize`, and POSTs `{ target, baseVersion, newBody }` to task
// 17's `/artifact` endpoint — echoing the OPAQUE `baseVersion` it was given, never computing a version
// (ADR-006). SourceMode is the raw-markdown escape hatch (still `normalize`d on save → byte-stable).
//
// Lock (ADR-006, UI side): an `in-progress` doc is read-only showing `lockedBy`; `todo`/`done` are
// editable; Take over flips the lock server-side then re-fetches. The client's lock belief is advisory —
// the server re-checks at write time. Editable artifacts are spec/plan/task-<NNN>; ADRs (`adr-*`) are
// decision records — READ-ONLY in V1 (Save disabled + a "read-only" header hint), distinct from the
// agent lock (an ADR is never agent-held — the lock bar stays driven by the agent lock alone).
//
// ── Pinned seams ────────────────────────────────────────────────────────────────────────────────────
//   • drawer-open trigger  → `selectDoc(docId)` / `useSelectedDoc()` (exported below). Panorama/DocNode
//     (task 12/13) call `selectDoc` on a node click; this drawer reads it. (DocNode is NOT edited here.)
//   • doc-fetch endpoint   → `GET /api/work/:id/doc/:docId` → DocModel (task 17 server territory; the
//     route may not exist yet — see the implementer's flag).
//   • comment rail (task 18) + diff drawer (task 19) → named render-slot props, so they plug in WITHOUT
//     editing this file.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
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
} from "./markdown-serializer.js";
import { CommentMark } from "./CommentMark.js";
import { LockBar } from "./LockBar.js";
import { SourceMode } from "./SourceMode.js";

/**
 * Paint the `comment` mark over a DOM `Range` in the open editor (AC5's in-editor highlight). The rail's
 * SelectionBubble holds the captured Range; on a submitted comment it calls this to highlight the span and
 * tag it with the comment id. The `comment` mark serializes to NOTHING (task 14), so the body round-trips
 * unchanged — the highlight is UI-only. A no-op when the editor isn't ready or the range can't be mapped
 * into ProseMirror coordinates (e.g. the selection landed outside the editable prose).
 */
export type ApplyCommentMark = (range: Range, commentId: string) => void;

// The live editor of the open document, published by DocBody so the shell-level comment rail (a grid
// sibling of the editor column) can paint the in-editor highlight without lifting the editor out of
// DocBody. Mirrors the module-level `selectDoc` store pattern above — one source, no prop-drilling across
// the grid boundary. Cleared when the body unmounts (drawer closes / doc switches).
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

// ── The selection seam (the drawer-open trigger this task pins) ───────────────────────────────────────
// A tiny module-level store: Panorama/DocNode call `selectDoc(id)` on a node click; the drawer subscribes
// via `useSelectedDoc()`. Kept here (not a separate store file) so the whole drawer-open contract lives in
// the one component the task owns — the node side only needs the exported `selectDoc`.
let selectedDocId: string | null = null;
const selectionListeners = new Set<() => void>();

/** Open the drawer on a doc (called by the Panorama node click — the pinned drawer-open trigger). */
export function selectDoc(docId: string | null): void {
  if (selectedDocId === docId) return;
  selectedDocId = docId;
  for (const l of selectionListeners) l();
}

function subscribeSelection(listener: () => void): () => void {
  selectionListeners.add(listener);
  return () => selectionListeners.delete(listener);
}

/** The currently-selected doc id (null = drawer closed). Drives DocDrawer's open/closed state. */
export function useSelectedDoc(): string | null {
  return useSyncExternalStore(subscribeSelection, () => selectedDocId, () => selectedDocId);
}

// ── Doc fetch (pinned: GET /api/work/:id/doc/:docId → DocModel) ───────────────────────────────────────
// Coded to the pinned path. `api/client.ts` is task 9's surface (not owned here), so the fetch is inline,
// matching that module's conventions (relative path, accept header, status→Error).
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

// The save POST (pinned: POST /api/work/:id/artifact { target, baseVersion, newBody }). The client echoes
// the OPAQUE baseVersion it was handed — it never computes a version (ADR-006). A 409 is the stale-version
// rejection (someone wrote in between); the message surfaces in the UI (AC6 feedback).
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

// ── Frontmatter projection (read-only, typed) ─────────────────────────────────────────────────────────
// FLOW frontmatter is loose (`Record<string, unknown>`); the header reads a few known fields defensively
// and renders them as READ-ONLY text. status / version / lockedBy are never user-editable (ADR-004).
function fmString(fm: Record<string, unknown>, key: string): string | null {
  const v = fm[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

type ViewMode = "rich" | "source";

export interface DocDrawerProps {
  runId: string;
  /**
   * The comment rail (task 18) — rendered in the right column when provided. Receives the live docId so
   * the rail can load that doc's review annotations, plus `applyCommentMark` so a submitted comment paints
   * the in-editor highlight on its span (AC5). A no-op until task 18 supplies it.
   */
  commentRail?: (ctx: { runId: string; docId: string; applyCommentMark: ApplyCommentMark }) => ReactNode;
  /**
   * The diff drawer (task 19) — rendered as an overlay when provided. Receives the live docId. A no-op
   * until task 19 supplies it.
   */
  diffDrawer?: (ctx: { runId: string; docId: string }) => ReactNode;
}

type Load =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; doc: DocModel };

export function DocDrawer({ runId, commentRail, diffDrawer }: DocDrawerProps) {
  useDocStyles();
  const docId = useSelectedDoc();
  const [load, setLoad] = useState<Load>({ kind: "idle" });

  const reload = useCallback(
    (id: string, signal: AbortSignal) => {
      setLoad({ kind: "loading" });
      fetchDoc(runId, id, signal)
        .then((doc) => setLoad({ kind: "ready", doc }))
        .catch((err: unknown) => {
          if (signal.aborted) return;
          setLoad({ kind: "error", message: err instanceof Error ? err.message : "failed to load doc" });
        });
    },
    [runId],
  );

  useEffect(() => {
    if (docId == null) {
      setLoad({ kind: "idle" });
      return;
    }
    const ctrl = new AbortController();
    reload(docId, ctrl.signal);
    return () => ctrl.abort();
  }, [docId, reload]);

  // Escape closes the drawer (a11y: a modal dialog must be dismissable from the keyboard). Bound while the
  // drawer is open; the listener is window-level so it fires regardless of where focus sits inside it.
  useEffect(() => {
    if (docId == null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") selectDoc(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [docId]);

  // The shell-level rail paints the in-editor highlight through this — stable identity so the rail (and the
  // SelectionBubble it mounts) doesn't re-subscribe each render; it reads the live editor via the module ref.
  const applyCommentMark = useMemo(() => makeApplyCommentMark(), []);

  if (docId == null) return null;

  return (
    <div className="dd-overlay" role="dialog" aria-modal="true" aria-label="Document">
      <div className="dd-main">
        {load.kind === "ready" ? (
          <DocBody
            key={docId}
            runId={runId}
            docId={docId}
            doc={load.doc}
            onReload={() => {
              const ctrl = new AbortController();
              reload(docId, ctrl.signal);
            }}
          />
        ) : load.kind === "error" ? (
          <div className="dd-state">
            <p className="dd-muted">Couldn't open this document: {load.message}</p>
          </div>
        ) : (
          <div className="dd-state" aria-busy="true" />
        )}
      </div>
      {commentRail ? <div className="dd-rail">{commentRail({ runId, docId, applyCommentMark })}</div> : null}
      {diffDrawer ? diffDrawer({ runId, docId }) : null}
    </div>
  );
}

// The loaded-doc body: header (read-only frontmatter), lock bar, toolbar, the rich/source editor, save.
// Split from DocDrawer so its hooks (the editor) only mount once a DocModel exists (and remount per docId
// via the `key`), keeping the fetch/overlay shell free of editor lifecycle.
function DocBody({
  runId,
  docId,
  doc,
  onReload,
}: {
  runId: string;
  docId: string;
  doc: DocModel;
  onReload: () => void;
}) {
  const fm = doc.frontmatter;
  const status = fmString(fm, "status");
  // ADRs are decision records — READ-ONLY in V1 (the editable artifacts are spec/plan/task-<NNN>). The
  // server rejects an adr-* write with `read_only`; the editor mirrors that by disabling Save and
  // showing a hint, so the read-only contract is felt before the round-trip, not after a 409. This is
  // SEPARATE from the agent lock: an ADR is never "an agent is writing it" — it just isn't editable
  // here, so the lock bar (with its Take-over affordance) stays driven by the agent lock alone.
  const readOnly = docId.startsWith("adr-");
  // Locked = the agent holds it: an explicit lock, or `status: in-progress` (ADR-006). lockedBy comes
  // from the lock holder, falling back to the frontmatter assignee/lockedBy field. Drives the LockBar.
  const locked = doc.lock != null || status === "in-progress";
  // Editable = neither agent-held nor a read-only artifact. Drives the editor + Save.
  const editable = !locked && !readOnly;
  const lockedBy = doc.lock?.by ?? fmString(fm, "lockedBy") ?? fmString(fm, "assignee");
  const kindLabel = (fmString(fm, "kind") ?? fmString(fm, "type") ?? "Doc").toUpperCase();
  const title = fmString(fm, "title") ?? docId;

  const [mode, setMode] = useState<ViewMode>("rich");
  // The raw source buffer mirrors `body`, seeded from the normalized on-disk body so a no-op source save
  // is byte-stable. It diverges from the rich editor only while source mode is the active editor.
  const [rawBody, setRawBody] = useState<string>(() => normalize(doc.body));
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const editor = useEditor(
    {
      // CommentMark is the UI-only `comment` mark (task 18): the in-editor highlight a submitted review
      // comment paints on its span. It serializes to NOTHING (task 14), so registering it leaves the
      // body's on-disk round-trip byte-stable — the highlight never reaches markdown.
      extensions: [StarterKit, Link.configure({ openOnClick: false }), CommentMark],
      content: mdToTiptap(doc.body) as ProseMirrorDoc,
      editable,
    },
    [docId],
  );

  // Publish this body's editor so the shell-level comment rail can paint the in-editor highlight (AC5).
  // Cleared on unmount (drawer close / doc switch) so a stale editor is never marked.
  useEffect(() => {
    liveEditor = editor ?? null;
    return () => {
      if (liveEditor === editor) liveEditor = null;
    };
  }, [editor]);

  // When editability changes (e.g. after Take over re-fetches, or a read-only doc), reflect it into the
  // live editor.
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  // Switching INTO source mode seeds the raw buffer from the current rich content (so an edit-then-toggle
  // doesn't lose work); switching back is intentionally one-way-per-toggle (source is the escape hatch,
  // not a live two-way bridge — re-parsing raw markdown into the rich editor is the next open).
  const toRich = useCallback(() => setMode("rich"), []);
  const toSource = useCallback(() => {
    if (editor) setRawBody(normalize(tiptapToMd(editor.getJSON() as ProseMirrorDoc)));
    setMode("source");
  }, [editor]);

  // The body to persist, normalized identically on both paths so a no-op edit is byte-stable (ADR-004/006).
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
    if (result.ok) onReload(); // pick up the freshly-stamped version
  }

  return (
    <>
      <div className="dd-bar">
        <button className="dd-back" type="button" onClick={() => selectDoc(null)}>
          ◂ panorama
        </button>
        <span className="dd-sep" aria-hidden="true" />
        <div className="dd-titles">
          <div className="dd-kind">{kindLabel}</div>
          <div className="dd-ttl">{title}</div>
        </div>
        <span className="dd-grow" />
        {/* Read-only typed frontmatter fields — status / version are FLOW-owned, never editable. */}
        {readOnly ? <span className="dd-field">read-only</span> : null}
        {status ? <span className="dd-field">{status}</span> : null}
        <span className="dd-field dd-mono">{doc.version || "—"}</span>
      </div>

      <LockBar
        locked={locked}
        lockedBy={lockedBy}
        version={doc.version}
        runId={runId}
        docId={docId}
        onTakenOver={onReload}
      />

      <div className="dd-toolbar">
        {mode === "rich" ? <RichToolbar editor={editor} disabled={!editable} /> : <span className="dd-muted">raw markdown — serializer bypassed</span>}
        <span className="dd-grow" />
        <div className="dd-modeswitch" role="group" aria-label="Editor mode">
          <button type="button" className={`dd-tb${mode === "rich" ? " on" : ""}`} onClick={toRich}>
            Rich
          </button>
          <button type="button" className={`dd-tb${mode === "source" ? " on" : ""}`} onClick={toSource}>
            Source
          </button>
        </div>
        <button type="button" className="dd-save" onClick={save} disabled={!editable || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {feedback ? (
        <div className="dd-feedback" role="status">
          {feedback}
        </div>
      ) : null}

      <div className="dd-editwrap">
        {mode === "rich" ? (
          <div className={`dd-prose${editable ? "" : " locked"}`}>
            <EditorContent editor={editor} />
          </div>
        ) : (
          <div className="dd-source">
            <SourceMode value={rawBody} onChange={setRawBody} readOnly={!editable} />
          </div>
        )}
      </div>
    </>
  );
}

// ── Rich toolbar — the prototype's bold/italic/H2/bullet/code marks, aligned to the serializer schema ──
function RichToolbar({ editor, disabled }: { editor: ReturnType<typeof useEditor>; disabled: boolean }) {
  // Subscribe to selection/transaction changes so active-state highlights stay live. (Cheap: a render
  // counter bumped on each editor update.)
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
// Injected once (descendant selectors — `.ProseMirror h1` etc. — can't be inline styles like the
// design-system primitives). Ported from prototype-document.html's doc-view block; every color reads a
// tokens.css variable, adding no new palette. Co-located here so the drawer's styling stays in its owned
// file (no new .css file outside the contract).
const STYLE_ID = "agentry-docdrawer-styles";
function useDocStyles(): void {
  useEffect(() => {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = DOC_CSS;
    document.head.appendChild(el);
  }, []);
}

const DOC_CSS = `
.dd-overlay{position:fixed;inset:0;z-index:80;display:grid;grid-template-columns:1fr 336px;
  background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(2px)}
.dd-overlay:not(:has(.dd-rail)){grid-template-columns:1fr}
.dd-main{display:flex;flex-direction:column;min-width:0;background:var(--bg);border-right:1px solid var(--line)}
.dd-state{flex:1;display:grid;place-items:center;padding:40px}
.dd-muted{color:var(--muted);font-size:12.5px}

.dd-bar{display:flex;align-items:center;gap:11px;padding:11px 18px;border-bottom:1px solid var(--line);
  background:var(--panel)}
.dd-back{cursor:pointer;color:var(--muted);font-size:12.5px;background:none;border:0;padding:0;font-family:var(--sans)}
.dd-back:hover{color:var(--ink)}
.dd-sep{width:1px;height:18px;background:var(--line2)}
.dd-grow{flex:1}
.dd-kind{font:700 10px var(--mono);letter-spacing:1.3px;text-transform:uppercase;color:var(--prog)}
.dd-ttl{font-weight:650;font-size:15px;color:var(--ink)}
.dd-field{font-size:11px;color:var(--muted);border:1px solid var(--line2);border-radius:var(--r-md);padding:4px 9px;
  text-transform:capitalize;white-space:nowrap}
.dd-field.dd-mono{font-family:var(--mono);text-transform:none;color:var(--faint)}

.dd-lockbar{display:flex;align-items:center;gap:9px;padding:8px 18px;font-size:12px;border-bottom:1px solid var(--line);
  background:color-mix(in srgb,var(--prog) 9%,transparent);color:var(--prog)}
.dd-lockbar.free{background:color-mix(in srgb,var(--done) 7%,transparent);color:var(--done)}
.dd-lockbar b{font-weight:700;margin:0 2px}
.dd-lock-hint{color:var(--muted)}
.dd-pulse{width:7px;height:7px;border-radius:50%;background:var(--prog);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--prog) 18%,transparent);flex:none}
.dd-takeover{display:inline-flex;align-items:center;gap:8px}
.dd-takeover-err{color:var(--block);font-size:11px}

.dd-toolbar{display:flex;align-items:center;gap:8px;padding:7px 16px;border-bottom:1px solid var(--line);
  background:var(--panel)}
.dd-marks,.dd-modeswitch{display:flex;align-items:center;gap:3px}
.dd-tb{min-width:30px;height:28px;padding:0 9px;border-radius:var(--r-sm);border:1px solid transparent;background:transparent;
  color:var(--muted);font-size:13px;cursor:pointer;display:grid;place-items:center;font-family:var(--sans)}
.dd-tb:hover{background:var(--hover);color:var(--ink)}
.dd-tb.on{background:var(--accent-soft);color:var(--accent-ink)}
.dd-tb:disabled{opacity:.3;cursor:not-allowed}
.dd-save{height:28px;padding:0 14px;border-radius:var(--r-md);border:1px solid transparent;cursor:pointer;
  background:var(--ink);color:var(--bg);font-weight:650;font-size:12.5px;font-family:var(--sans)}
.dd-save:disabled{opacity:.4;cursor:not-allowed}
.dd-feedback{padding:7px 18px;font-size:12px;color:var(--muted);background:var(--panel2);border-bottom:1px solid var(--line)}

.dd-editwrap{flex:1;overflow:auto;display:flex;justify-content:center;padding:30px 24px 80px}
.dd-prose,.dd-source{max-width:760px;width:100%}
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

.dd-rail{display:flex;flex-direction:column;min-width:0;background:var(--side-bg)}
`;
